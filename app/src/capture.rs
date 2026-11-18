//! Captura nativa (Windows) de uma tela, de uma janela e do som do computador, para os gravadores (o AllRecording,
//! por exemplo): sem a janela "Escolha o que compartilhar" do navegador e sem precisar marcar "Compartilhar áudio
//! do sistema". O plugin mostra um seletor próprio com as fontes de `capture/sources` e abre o WebSocket
//! `/api/capture/ws`: a imagem chega em JPEG (desenhada num canvas) e o som em PCM float (tocado num AudioWorklet),
//! e o MediaRecorder da página grava como sempre.
//! Só pelo PC local e só pela própria página (o WebSocket confere a origem como o terminal).
use crate::plugins::{RouteFn, ok, route_fn};
use axum::body::Body;
use axum::extract::FromRequest;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use bluescreen_sdk::util::fail;
use serde_json::json;
use std::collections::HashMap;

pub fn routes() -> Vec<(&'static str, RouteFn)> {
    vec![("capture/sources", route_fn(|r| async move {
        r.local_only()?;
        let thumbs = r.q("thumbs") != Some("0");
        let v = tokio::task::spawn_blocking(move || imp::sources(thumbs)).await.map_err(|e| fail(e.to_string(), 500))?;
        ok(v)
    }))]
}

/// GET /api/capture/ws?src=audio | src=m<n> (tela) | src=w<janela>&fps=15&max=1920
/// Daqui para lá: texto JSON {"audio": {rate, ch}} / {"video": {w, h}} / {"error": msg} / {"gone": true} e binários
/// (PCM f32 intercalado, 2 canais; ou um JPEG por quadro).
pub async fn ws(req: Request<Body>, remote: bool, q: HashMap<String, String>) -> Response {
    if remote { return (StatusCode::FORBIDDEN, "só pelo PC local").into_response(); }
    if !crate::server::ws_origin_ok(req.headers(), remote) { return (StatusCode::FORBIDDEN, "origem não permitida").into_response(); }
    let src = q.get("src").cloned().unwrap_or_default();
    let fps = q.get("fps").and_then(|v| v.parse::<u32>().ok()).unwrap_or(15).clamp(1, 60);
    let max = q.get("max").and_then(|v| v.parse::<u32>().ok()).unwrap_or(1920).clamp(160, 3840);
    match WebSocketUpgrade::from_request(req, &()).await {
        Ok(up) => up.on_upgrade(move |s| session(s, src, fps, max)),
        Err(e) => e.into_response(),
    }
}

async fn session(mut ws: WebSocket, src: String, fps: u32, max: u32) {
    // a captura é bloqueante (GDI, WASAPI): uma thread que manda pelo canal; o WebSocket fechado fecha o canal e ela para
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Message>(4);
    let audio = src == "audio";
    let _ = std::thread::Builder::new().name("bs-capture".into()).spawn(move || {
        if audio { imp::audio_loop(tx) } else { imp::video_loop(tx, &src, fps, max) }
    });
    loop {
        tokio::select! {
            m = rx.recv() => match m {
                Some(m) => if ws.send(m).await.is_err() { break },
                None => break,
            },
            m = ws.recv() => match m {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                _ => {}
            },
        }
    }
    drop(rx);
    let _ = ws.send(Message::Close(None)).await;
}

fn text(v: serde_json::Value) -> Message { Message::Text(v.to_string().into()) }

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn sources(_: bool) -> serde_json::Value { json!({ "supported": false, "screens": [], "windows": [] }) }
    pub fn audio_loop(tx: tokio::sync::mpsc::Sender<Message>) { let _ = tx.blocking_send(text(json!({ "error": "captura nativa só no Windows" }))); }
    pub fn video_loop(tx: tokio::sync::mpsc::Sender<Message>, _: &str, _: u32, _: u32) { audio_loop(tx) }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use base64::Engine;
    use std::time::{Duration, Instant};
    use tokio::sync::mpsc::Sender;
    use tokio::sync::mpsc::error::TrySendError;
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT};
    use windows_sys::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::Storage::Xps::PrintWindow;
    use windows_sys::Win32::System::Threading::{GetCurrentProcessId, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW};
    use windows_sys::Win32::UI::HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext};
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    // ---------- fontes ----------
    #[derive(Clone)]
    struct Mon { rect: RECT, primary: bool }

    fn monitors() -> Vec<Mon> {
        unsafe extern "system" fn cb(h: HMONITOR, _: HDC, _: *mut RECT, l: LPARAM) -> i32 {
            let v = unsafe { &mut *(l as *mut Vec<Mon>) };
            let mut mi: MONITORINFO = unsafe { std::mem::zeroed() };
            mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            if unsafe { GetMonitorInfoW(h, &mut mi) } != 0 { v.push(Mon { rect: mi.rcMonitor, primary: mi.dwFlags & 1 != 0 }); }
            1
        }
        let mut v: Vec<Mon> = Vec::new();
        unsafe { EnumDisplayMonitors(std::ptr::null_mut(), std::ptr::null(), Some(cb), &mut v as *mut _ as LPARAM) };
        // a principal primeiro, depois da esquerda para a direita (a ordem do Windows muda a cada ligação de monitor)
        v.sort_by_key(|m| (!m.primary, m.rect.left, m.rect.top));
        v
    }

    fn wtext(h: HWND) -> String {
        let n = unsafe { GetWindowTextLengthW(h) };
        if n <= 0 { return String::new(); }
        let mut b = vec![0u16; n as usize + 1];
        let got = unsafe { GetWindowTextW(h, b.as_mut_ptr(), b.len() as i32) };
        String::from_utf16_lossy(&b[..got.max(0) as usize])
    }

    fn exe_of(h: HWND) -> (u32, String) {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(h, &mut pid) };
        let ph = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if ph.is_null() { return (pid, String::new()); }
        let mut b = vec![0u16; 1024];
        let mut n = b.len() as u32;
        let ok = unsafe { QueryFullProcessImageNameW(ph, PROCESS_NAME_WIN32, b.as_mut_ptr(), &mut n) } != 0;
        unsafe { CloseHandle(ph) };
        if !ok { return (pid, String::new()); }
        let full = String::from_utf16_lossy(&b[..n as usize]);
        (pid, full.rsplit('\\').next().unwrap_or("").to_string())
    }

    /// Retângulo visível da janela (sem a borda invisível de redimensionar do Windows 10/11).
    fn frame_rect(h: HWND) -> RECT {
        let mut r: RECT = unsafe { std::mem::zeroed() };
        let hr = unsafe { DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS as u32, &mut r as *mut _ as *mut _, std::mem::size_of::<RECT>() as u32) };
        if hr != 0 { unsafe { GetWindowRect(h, &mut r) }; }
        r
    }

    fn windows() -> Vec<(HWND, String, String)> {
        unsafe extern "system" fn cb(h: HWND, l: LPARAM) -> i32 {
            let v = unsafe { &mut *(l as *mut Vec<HWND>) };
            v.push(h);
            1
        }
        let mut all: Vec<HWND> = Vec::new();
        unsafe { EnumWindows(Some(cb), &mut all as *mut _ as LPARAM) };
        let me = unsafe { GetCurrentProcessId() };
        let mut out = Vec::new();
        for h in all {
            if unsafe { IsWindowVisible(h) } == 0 || !unsafe { GetWindow(h, GW_OWNER) }.is_null() { continue; }
            let ex = unsafe { GetWindowLongW(h, GWL_EXSTYLE) } as u32;
            if ex & WS_EX_TOOLWINDOW != 0 { continue; }
            let mut cloaked = 0u32;
            unsafe { DwmGetWindowAttribute(h, DWMWA_CLOAKED as u32, &mut cloaked as *mut _ as *mut _, 4) };
            if cloaked != 0 { continue; }
            let title = wtext(h);
            if title.trim().is_empty() { continue; }
            let r = frame_rect(h);
            let minimized = unsafe { IsIconic(h) } != 0;
            if !minimized && (r.right - r.left < 80 || r.bottom - r.top < 60) { continue; }
            let (pid, exe) = exe_of(h);
            // as janelas do próprio BlueScreen ficam de fora (gravar a IDE gravando ela mesma)
            if pid == me || exe.eq_ignore_ascii_case("explorer.exe") && title == "Program Manager" { continue; }
            out.push((h, title, exe));
        }
        out
    }

    pub fn sources(thumbs: bool) -> serde_json::Value {
        let _dpi = Dpi::per_monitor();
        let mut enc = Jpeg::new();
        let mut thumb = |src: &Src| -> serde_json::Value {
            if !thumbs { return serde_json::Value::Null; }
            let Some(f) = grab(src, 320, 200, false) else { return serde_json::Value::Null };
            match enc.as_mut().and_then(|e| e.encode(&f, 0.7).ok()) {
                Some(b) => json!(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(b))),
                None => serde_json::Value::Null,
            }
        };
        let mons = monitors();
        let screens: Vec<_> = mons.iter().enumerate().map(|(i, m)| {
            let (w, h) = (m.rect.right - m.rect.left, m.rect.bottom - m.rect.top);
            json!({ "id": format!("m{i}"), "name": format!("Tela {}", i + 1), "primary": m.primary, "w": w, "h": h, "thumb": thumb(&Src::Mon(m.clone())) })
        }).collect();
        let wins: Vec<_> = windows().into_iter().map(|(h, title, exe)| {
            let minimized = unsafe { IsIconic(h) } != 0;
            let app = exe.trim_end_matches(".exe").trim_end_matches(".EXE").to_string();
            json!({ "id": format!("w{}", h as isize), "name": title, "app": app, "minimized": minimized, "thumb": if minimized { serde_json::Value::Null } else { thumb(&Src::Win(h)) } })
        }).collect();
        json!({ "supported": true, "screens": screens, "windows": wins })
    }

    // ---------- imagem ----------
    enum Src { Mon(Mon), Win(HWND) }

    fn parse_src(s: &str) -> Option<Src> {
        if let Some(n) = s.strip_prefix('m') { return monitors().get(n.parse::<usize>().ok()?).cloned().map(Src::Mon); }
        let h = s.strip_prefix('w')?.parse::<isize>().ok()? as HWND;
        if unsafe { IsWindow(h) } == 0 { return None; }
        Some(Src::Win(h))
    }

    /// Quadro BGR de 24 bits, de cima para baixo, linhas alinhadas em 4 bytes.
    pub struct Frame { w: u32, h: u32, stride: u32, px: Vec<u8> }

    struct Dpi(isize);
    impl Dpi { fn per_monitor() -> Self { Dpi(unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) } as isize) } }
    impl Drop for Dpi { fn drop(&mut self) { if self.0 != 0 { unsafe { SetThreadDpiAwarenessContext(self.0 as _) }; } } }

    fn fit(w: i32, h: i32, maxw: u32, maxh: u32) -> (i32, i32) {
        let k = (maxw as f64 / w as f64).min(maxh as f64 / h as f64).min(1.0);
        // tamanhos pares: o codificador de vídeo da página prefere
        (((w as f64 * k) as i32 / 2 * 2).max(2), ((h as f64 * k) as i32 / 2 * 2).max(2))
    }

    fn draw_cursor(dc: HDC, left: i32, top: i32, k: f64) {
        let mut ci: CURSORINFO = unsafe { std::mem::zeroed() };
        ci.cbSize = std::mem::size_of::<CURSORINFO>() as u32;
        if unsafe { GetCursorInfo(&mut ci) } == 0 || ci.flags & CURSOR_SHOWING == 0 || ci.hCursor.is_null() { return; }
        let mut ii: ICONINFO = unsafe { std::mem::zeroed() };
        let (mut hx, mut hy) = (0, 0);
        if unsafe { GetIconInfo(ci.hCursor, &mut ii) } != 0 {
            hx = ii.xHotspot as i32; hy = ii.yHotspot as i32;
            if !ii.hbmMask.is_null() { unsafe { DeleteObject(ii.hbmMask) }; }
            if !ii.hbmColor.is_null() { unsafe { DeleteObject(ii.hbmColor) }; }
        }
        let size = (32.0 * k).round().max(8.0) as i32;
        let x = ((ci.ptScreenPos.x - hx - left) as f64 * k) as i32;
        let y = ((ci.ptScreenPos.y - hy - top) as f64 * k) as i32;
        unsafe { DrawIconEx(dc, x, y, ci.hCursor, size, size, 0, std::ptr::null_mut(), DI_NORMAL) };
    }

    fn grab(src: &Src, maxw: u32, maxh: u32, cursor: bool) -> Option<Frame> {
        unsafe {
            let screen = GetDC(std::ptr::null_mut());
            if screen.is_null() { return None; }
            let out_dc = CreateCompatibleDC(screen);
            let mut tmp: Option<(HDC, HBITMAP)> = None;
            let (sw, sh, ow, oh, ok);
            let out_bmp: HBITMAP;
            match src {
                Src::Mon(m) => {
                    let r = m.rect;
                    sw = r.right - r.left; sh = r.bottom - r.top;
                    (ow, oh) = fit(sw, sh, maxw, maxh);
                    out_bmp = CreateCompatibleBitmap(screen, ow, oh);
                    SelectObject(out_dc, out_bmp);
                    ok = if (ow, oh) == (sw, sh) { BitBlt(out_dc, 0, 0, ow, oh, screen, r.left, r.top, SRCCOPY | CAPTUREBLT) != 0 }
                        else { SetStretchBltMode(out_dc, HALFTONE); SetBrushOrgEx(out_dc, 0, 0, std::ptr::null_mut()); StretchBlt(out_dc, 0, 0, ow, oh, screen, r.left, r.top, sw, sh, SRCCOPY | CAPTUREBLT) != 0 };
                    if ok && cursor { draw_cursor(out_dc, r.left, r.top, ow as f64 / sw as f64); }
                }
                Src::Win(h) => {
                    // a janela inteira (com a borda invisível) é desenhada por ela mesma, mesmo atrás de outras;
                    // depois recorta a parte visível
                    let mut wr: RECT = std::mem::zeroed();
                    GetWindowRect(*h, &mut wr);
                    let fr = frame_rect(*h);
                    let (ww, wh) = (wr.right - wr.left, wr.bottom - wr.top);
                    sw = (fr.right - fr.left).max(2); sh = (fr.bottom - fr.top).max(2);
                    if ww < 2 || wh < 2 { ReleaseDC(std::ptr::null_mut(), screen); DeleteDC(out_dc); return None; }
                    let tdc = CreateCompatibleDC(screen);
                    let tbmp = CreateCompatibleBitmap(screen, ww, wh);
                    SelectObject(tdc, tbmp);
                    tmp = Some((tdc, tbmp));
                    let printed = PrintWindow(*h, tdc, 2 /* PW_RENDERFULLCONTENT */) != 0;
                    (ow, oh) = fit(sw, sh, maxw, maxh);
                    out_bmp = CreateCompatibleBitmap(screen, ow, oh);
                    SelectObject(out_dc, out_bmp);
                    SetStretchBltMode(out_dc, HALFTONE); SetBrushOrgEx(out_dc, 0, 0, std::ptr::null_mut());
                    ok = printed && StretchBlt(out_dc, 0, 0, ow, oh, tdc, fr.left - wr.left, fr.top - wr.top, sw, sh, SRCCOPY) != 0;
                    if ok && cursor {
                        let mut p: POINT = std::mem::zeroed();
                        GetCursorPos(&mut p);
                        if WindowFromPoint(p) == *h || GetAncestor(WindowFromPoint(p), GA_ROOT) == *h { draw_cursor(out_dc, fr.left, fr.top, ow as f64 / sw as f64); }
                    }
                }
            }
            let mut frame = None;
            if ok {
                let stride = ((ow as u32 * 3) + 3) & !3;
                let mut px = vec![0u8; (stride * oh as u32) as usize];
                let mut bi: BITMAPINFO = std::mem::zeroed();
                bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
                bi.bmiHeader.biWidth = ow; bi.bmiHeader.biHeight = -oh; // negativo: de cima para baixo
                bi.bmiHeader.biPlanes = 1; bi.bmiHeader.biBitCount = 24; bi.bmiHeader.biCompression = BI_RGB as u32;
                // o bitmap não pode estar selecionado num DC na hora do GetDIBits
                SelectObject(out_dc, GetStockObject(BLACK_BRUSH) as _);
                let lines = GetDIBits(screen, out_bmp, 0, oh as u32, px.as_mut_ptr() as *mut _, &mut bi, DIB_RGB_COLORS);
                if lines == oh { frame = Some(Frame { w: ow as u32, h: oh as u32, stride, px }); }
            }
            if let Some((tdc, tbmp)) = tmp { DeleteDC(tdc); DeleteObject(tbmp); }
            if !out_bmp.is_null() { DeleteObject(out_bmp); }
            DeleteDC(out_dc);
            ReleaseDC(std::ptr::null_mut(), screen);
            frame
        }
    }

    // ---------- JPEG (Windows Imaging Component: rápido e sem dependência nova) ----------
    struct Jpeg { factory: windows::Win32::Graphics::Imaging::IWICImagingFactory }
    impl Jpeg {
        fn new() -> Option<Self> {
            use windows::Win32::Graphics::Imaging::*;
            use windows::Win32::System::Com::*;
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok().map(|factory| Jpeg { factory })
            }
        }
        fn encode(&mut self, f: &Frame, quality: f32) -> windows::core::Result<Vec<u8>> {
            use windows::Win32::Graphics::Imaging::*;
            use windows::Win32::System::Com::StructuredStorage::*;
            use windows::Win32::System::Com::*;
            use windows::Win32::System::Memory::*;
            use windows::Win32::System::Variant::VARIANT;
            unsafe {
                let stream = CreateStreamOnHGlobal(Default::default(), true)?;
                let enc = self.factory.CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null())?;
                enc.Initialize(&stream, WICBitmapEncoderNoCache)?;
                let (mut frame, mut bag) = (None, None);
                enc.CreateNewFrame(&mut frame, &mut bag)?;
                let frame = frame.ok_or_else(windows::core::Error::empty)?;
                let bag = bag.ok_or_else(windows::core::Error::empty)?;
                let mut name: Vec<u16> = "ImageQuality\0".encode_utf16().collect();
                let opt = PROPBAG2 { pstrName: windows::core::PWSTR(name.as_mut_ptr()), ..Default::default() };
                let _ = bag.Write(1, &opt, &VARIANT::from(quality));
                frame.Initialize(&bag)?;
                frame.SetSize(f.w, f.h)?;
                let mut fmt = GUID_WICPixelFormat24bppBGR;
                frame.SetPixelFormat(&mut fmt)?;
                frame.WritePixels(f.h, f.stride, &f.px)?;
                frame.Commit()?;
                enc.Commit()?;
                let mut len = 0u64;
                stream.Seek(0, STREAM_SEEK_CUR, Some(&mut len))?;
                let hg = GetHGlobalFromStream(&stream)?;
                let p = GlobalLock(hg) as *const u8;
                if p.is_null() { return Err(windows::core::Error::empty()); }
                let out = std::slice::from_raw_parts(p, len as usize).to_vec();
                let _ = GlobalUnlock(hg);
                Ok(out)
            }
        }
    }

    pub fn video_loop(tx: Sender<Message>, src: &str, fps: u32, max: u32) {
        let _dpi = Dpi::per_monitor();
        let Some(src) = parse_src(src) else { let _ = tx.blocking_send(text(json!({ "error": "Essa tela ou janela não existe mais." }))); return };
        let Some(mut enc) = Jpeg::new() else { let _ = tx.blocking_send(text(json!({ "error": "O Windows não deixou criar o codificador de imagem." }))); return };
        let period = Duration::from_secs_f64(1.0 / fps as f64);
        let mut size = (0, 0);
        let mut next = Instant::now();
        loop {
            if tx.is_closed() { return; }
            if let Src::Win(h) = src { if unsafe { IsWindow(h) } == 0 { let _ = tx.blocking_send(text(json!({ "gone": true }))); return; } }
            // janela minimizada: segura o último quadro (a página repete o que já tem)
            let minimized = matches!(src, Src::Win(h) if unsafe { IsIconic(h) } != 0);
            if !minimized {
                if let Some(f) = grab(&src, max, max, true) {
                    if (f.w, f.h) != size { size = (f.w, f.h); if tx.blocking_send(text(json!({ "video": { "w": f.w, "h": f.h } }))).is_err() { return; } }
                    if let Ok(b) = enc.encode(&f, 0.8) {
                        // a página está atrasada (aba em segundo plano, disco lento): perde o quadro em vez de acumular
                        if let Err(TrySendError::Closed(_)) = tx.try_send(Message::Binary(b.into())) { return; }
                    }
                }
            }
            next += period;
            let now = Instant::now();
            if next > now { std::thread::sleep(next - now); } else { next = now; }
        }
    }

    // ---------- som do computador (WASAPI loopback do alto-falante padrão) ----------
    pub fn audio_loop(tx: Sender<Message>) {
        use windows::Win32::System::Com::*;
        unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }
        let mut first = true;
        // a saída padrão pode mudar no meio (fone ligado, Bluetooth): reabre o dispositivo novo e continua
        while !tx.is_closed() {
            if let Err(e) = unsafe { loopback(&tx, &mut first) } {
                if first { let _ = tx.blocking_send(text(json!({ "error": format!("Não deu para ouvir o som do computador: {e}") }))); return; }
                std::thread::sleep(Duration::from_millis(400));
            }
        }
    }

    unsafe fn loopback(tx: &Sender<Message>, first: &mut bool) -> windows::core::Result<()> {
        use windows::Win32::Media::Audio::*;
        use windows::Win32::Media::Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
        use windows::Win32::System::Com::*;
        unsafe {
            let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let dev = en.GetDefaultAudioEndpoint(eRender, eConsole)?;
            let client: IAudioClient = dev.Activate(CLSCTX_ALL, None)?;
            let fmt = client.GetMixFormat()?;
            let wf = *fmt;
            let (rate, ch, bits) = (wf.nSamplesPerSec, wf.nChannels as usize, wf.wBitsPerSample);
            let float = wf.wFormatTag == 3 || (wf.wFormatTag == 0xFFFE /* WAVE_FORMAT_EXTENSIBLE */ && { let sub = std::ptr::read_unaligned(std::ptr::addr_of!((*(fmt as *const WAVEFORMATEXTENSIBLE)).SubFormat)); sub == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT });
            let r = client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 2_000_000, 0, fmt, None);
            CoTaskMemFree(Some(fmt as *const _));
            r?;
            let cap: IAudioCaptureClient = client.GetService()?;
            client.Start()?;
            if *first {
                *first = false;
                if tx.blocking_send(text(json!({ "audio": { "rate": rate, "ch": 2 } }))).is_err() { return Ok(()); }
            }
            let bytes = (bits / 8) as usize;
            let sample = |p: *const u8| -> f32 {
                match (float, bits) {
                    (true, 32) => *(p as *const f32),
                    (false, 16) => *(p as *const i16) as f32 / 32768.0,
                    (false, 24) => { let b = std::slice::from_raw_parts(p, 3); ((b[0] as i32) << 8 | (b[1] as i32) << 16 | (b[2] as i32) << 24) as f32 / 2147483648.0 }
                    (false, 32) => *(p as *const i32) as f32 / 2147483648.0,
                    _ => 0.0,
                }
            };
            let res = (|| -> windows::core::Result<()> {
                loop {
                    std::thread::sleep(Duration::from_millis(10));
                    if tx.is_closed() { return Ok(()); }
                    let mut out: Vec<f32> = Vec::new();
                    while cap.GetNextPacketSize()? > 0 {
                        let (mut data, mut frames, mut flags) = (std::ptr::null_mut(), 0u32, 0u32);
                        cap.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
                        let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
                        for i in 0..frames as usize {
                            if silent || data.is_null() { out.extend_from_slice(&[0.0, 0.0]); continue; }
                            let at = |c: usize| sample(data.add((i * ch + c.min(ch - 1)) * bytes));
                            out.push(at(0)); out.push(at(1));
                        }
                        cap.ReleaseBuffer(frames)?;
                    }
                    if out.is_empty() { continue; }
                    let mut b = Vec::with_capacity(out.len() * 4);
                    for s in out { b.extend_from_slice(&s.to_le_bytes()); }
                    if tx.blocking_send(Message::Binary(b.into())).is_err() { return Ok(()); }
                }
            })();
            let _ = client.Stop();
            res
        }
    }
}
