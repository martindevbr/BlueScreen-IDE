//! Janela em que você digita (ou cola) o que um segredo do cofre precisa: um token, usuário e senha, o que o plugin
//! pediu. Fica fora da página da IDE: nenhum `ui.js` lê o que se digita aqui nem clica em "Guardar". Abrir esta janela
//! já é a confirmação de gravar (ela mostra para onde o segredo pode ir).
//!
//! Com a janela do aplicativo aberta (desktop.rs), é uma janela própria do BlueScreen com WebView, no tema da IDE: a
//! página dela vem desta string (vault_input.html, origem nula), sem nada servido pelo núcleo, então nem um service
//! worker de plugin a alcança. Sem a janela do aplicativo (IDE no navegador), uma janela Win32 simples.
use serde::Serialize;
use serde_json::{Value, json};

/// O que a janela mostra.
pub struct Prompt {
    /// o segredo já existe (trocar)
    pub replace: bool,
    pub name: String,
    pub hosts: Vec<String>,
    pub programs: Vec<String>,
    pub fields: Vec<Ask>,
    /// onde fica guardado, quando não é o Cofre da IDE ("nas credenciais do Automator"); vazio: o cofre
    pub place: &'static str,
}
impl Prompt {
    fn spec(&self) -> Value {
        json!({ "replace": self.replace, "name": self.name, "hosts": self.hosts, "programs": self.programs, "fields": self.fields, "place": self.place })
    }
    fn text(&self) -> String {
        let fields = self.fields.iter().map(|f| f.label.as_str()).collect::<Vec<_>>().join(", ");
        let verb = if self.replace { "Trocar" } else { "Guardar" };
        if !self.place.is_empty() {
            return format!("{verb} \"{}\" {}: {fields}.\n\nDigite ou cole (Ctrl+V). O que você digita aqui fica cifrado neste PC e não passa pela página do BlueScreen.", self.name, self.place);
        }
        format!("{verb} \"{}\" no cofre: {fields}.\n\nPode ir para: {}\nProgramas: {}\n\nDigite ou cole (Ctrl+V). O que você digita aqui fica cifrado neste PC e não passa pela página do BlueScreen.",
            self.name,
            if self.hosts.is_empty() { "nenhum site ainda".to_string() } else { self.hosts.join(", ") },
            if self.programs.is_empty() { "nenhum".to_string() } else { self.programs.join(", ") })
    }
}

/// A página da janela (desktop.rs): o pedido entra como JSON, com as fontes da IDE embutidas.
pub fn html(spec: &Value, dark: bool) -> String {
    use base64::Engine;
    let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
    let font = |w: u16, b: &[u8]| format!("@font-face {{ font-family: 'IBM Plex Sans'; font-weight: {w}; src: url(data:font/woff2;base64,{}) format('woff2'); }}", b64(b));
    let fonts = [
        font(400, include_bytes!("../../wwwroot/vendor/fonts/ibm-plex-sans-latin-400-normal.woff2")),
        font(500, include_bytes!("../../wwwroot/vendor/fonts/ibm-plex-sans-latin-500-normal.woff2")),
        font(600, include_bytes!("../../wwwroot/vendor/fonts/ibm-plex-sans-latin-600-normal.woff2")),
        format!("@font-face {{ font-family: 'JetBrains Mono'; font-weight: 400; src: url(data:font/woff2;base64,{}) format('woff2'); }}", b64(include_bytes!("../../wwwroot/vendor/fonts/jetbrains-mono-latin-400-normal.woff2"))),
    ].join("\n");
    include_str!("vault_input.html")
        .replace("/*FONTS*/", &fonts)
        .replace("/*THEME*/", if dark { "dark" } else { "light" })
        // dentro de <script>: "</" quebraria a tag
        .replace("/*SPEC*/", &spec.to_string().replace("</", "<\\/"))
}

/// Um campo da janela.
#[derive(Serialize)]
pub struct Ask {
    pub label: String,
    /// mostrado como •••
    pub secret: bool,
    /// pode ficar vazio
    pub optional: bool,
    /// formato: "" (texto), "multiline", "url", "email", "number"
    pub kind: String,
    /// texto já preenchido (só campos que não são secretos)
    pub prefill: String,
    /// já tem valor guardado: vazio mantém o atual
    pub keep: bool,
}

/// Mostra a janela e espera. Some(valores, na ordem dos campos) com "Guardar"; None com "Cancelar" ou fechada.
pub fn ask(p: &Prompt) -> Option<Vec<String>> {
    if let Some(ui) = crate::server::UI.get() {
        let (tx, rx) = std::sync::mpsc::channel();
        ui(crate::server::UiEvent::Prompt(p.spec(), tx));
        // janela fechada sem resposta (ou o aplicativo saindo): o canal cai e conta como cancelado
        return rx.recv().ok().flatten().filter(|v: &Vec<String>| v.len() == p.fields.len());
    }
    native(p)
}
#[cfg(windows)]
fn native(p: &Prompt) -> Option<Vec<String>> { win::ask("BlueScreen · Cofre", &p.text(), &p.fields) }
#[cfg(not(windows))]
fn native(_: &Prompt) -> Option<Vec<String>> { None }

#[cfg(windows)]
mod win {
    use super::Ask;
    use std::cell::RefCell;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::HiDpi::GetDpiForSystem;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::SetFocus;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    // estilos e mensagens dos controles comuns (as constantes do windows-sys vêm com tipos diferentes)
    const ES_AUTOHSCROLL: u32 = 0x80;
    const ES_PASSWORD: u32 = 0x20;
    const ES_MULTILINE: u32 = 0x4;
    const ES_AUTOVSCROLL: u32 = 0x40;
    const ES_WANTRETURN: u32 = 0x1000;
    const SS_NOPREFIX: u32 = 0x80;
    const BS_DEFPUSHBUTTON: u32 = 1;
    const BS_AUTOCHECKBOX: u32 = 3;
    const EM_SETPASSWORDCHAR: u32 = 0xCC;
    const EM_LIMITTEXT: u32 = 0xC5;
    const BM_GETCHECK: u32 = 0xF0;
    const ID_OK: usize = 1;
    const ID_CANCEL: usize = 2;
    const ID_SHOW: usize = 100;
    const ID_EDIT: usize = 200;
    const ID_ERR: usize = 300;
    const DOT: usize = 0x25CF;

    struct St { edits: Vec<HWND>, fields: Vec<(bool, bool, String, String)>, show: HWND, err: HWND, out: Option<Vec<String>> }
    /// o que está errado no valor de um campo, pelo formato
    fn wrong(kind: &str, v: &str) -> Option<&'static str> {
        if v.is_empty() { return None; }
        match kind {
            "url" if !(v.starts_with("https://") || v.starts_with("http://")) || v.contains(char::is_whitespace) => Some("precisa ser um endereço que começa com https://"),
            "email" if !v.split_once('@').is_some_and(|(a, b)| !a.is_empty() && b.contains('.') && !v.contains(char::is_whitespace)) => Some("precisa ser um e-mail (nome@dominio.com)"),
            "number" if !v.chars().all(|c| c.is_ascii_digit()) => Some("só números"),
            _ => None,
        }
    }
    thread_local! { static ST: RefCell<Option<St>> = const { RefCell::new(None) }; }

    fn w(s: &str) -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() }
    unsafe fn text_of(h: HWND) -> String {
        unsafe {
            let n = GetWindowTextLengthW(h).max(0) as usize;
            let mut buf = vec![0u16; n + 1];
            let got = GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32).max(0) as usize;
            let s = String::from_utf16_lossy(&buf[..got]);
            buf.iter_mut().for_each(|c| *c = 0);
            s
        }
    }

    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        unsafe {
            match msg {
                WM_COMMAND => {
                    let id = wp & 0xFFFF;
                    // só cópias dos identificadores: SetFocus e DestroyWindow voltam a chamar esta função
                    let Some((edits, fields, show, err)) = ST.with(|s| s.borrow().as_ref().map(|s| (s.edits.clone(), s.fields.clone(), s.show, s.err))) else { return 0 };
                    match id {
                        ID_OK => {
                            let vals: Vec<String> = edits.iter().map(|&e| text_of(e).replace("\r\n", "\n").trim().to_string()).collect();
                            // obrigatório vazio (e sem valor guardado para manter): volta para ele
                            let bad = vals.iter().zip(&fields).enumerate().find_map(|(i, (v, (optional, keep, kind, label)))| {
                                if v.is_empty() && !optional && !keep { Some((i, format!("Preencha: {label}"))) } else { wrong(kind, v).map(|m| (i, format!("{label}: {m}"))) }
                            });
                            if let Some((i, m)) = bad {
                                let m: Vec<u16> = m.encode_utf16().chain(std::iter::once(0)).collect();
                                SetWindowTextW(err, m.as_ptr());
                                SetFocus(edits[i]);
                                return 0;
                            }
                            ST.with(|s| if let Some(s) = s.borrow_mut().as_mut() { s.out = Some(vals) });
                            DestroyWindow(hwnd);
                        }
                        ID_CANCEL => { DestroyWindow(hwnd); }
                        ID_SHOW if (wp >> 16) & 0xFFFF == 0 => {
                            let visible = SendMessageW(show, BM_GETCHECK, 0, 0) == 1;
                            for &e in &edits {
                                if GetWindowLongW(e, GWL_STYLE) as u32 & ES_PASSWORD != 0 {
                                    SendMessageW(e, EM_SETPASSWORDCHAR, if visible { 0 } else { DOT }, 0);
                                    InvalidateRect(e, std::ptr::null(), 1);
                                }
                            }
                        }
                        _ => {}
                    }
                    0
                }
                WM_CLOSE => { DestroyWindow(hwnd); 0 }
                WM_DESTROY => { PostQuitMessage(0); 0 }
                _ => DefWindowProcW(hwnd, msg, wp, lp),
            }
        }
    }

    pub fn ask(title: &str, text: &str, fields: &[Ask]) -> Option<Vec<String>> {
        // SAFETY: janela e controles criados e destruídos nesta thread, que roda o próprio laço de mensagens até a
        // janela fechar; textos UTF-16 terminados em zero vivos durante cada chamada
        unsafe {
            let inst = GetModuleHandleW(std::ptr::null());
            let class = w("BlueScreenVaultInput");
            let wc = WNDCLASSW {
                style: 0, lpfnWndProc: Some(proc), cbClsExtra: 0, cbWndExtra: 0, hInstance: inst, hIcon: std::ptr::null_mut(),
                hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW), hbrBackground: GetSysColorBrush(COLOR_BTNFACE),
                lpszMenuName: std::ptr::null(), lpszClassName: class.as_ptr(),
            };
            RegisterClassW(&wc); // a segunda vez falha por já existir, e tudo bem

            // fonte e escala do sistema (o BlueScreen é DPI-aware)
            let mut nm: NONCLIENTMETRICSW = std::mem::zeroed();
            nm.cbSize = std::mem::size_of::<NONCLIENTMETRICSW>() as u32;
            SystemParametersInfoW(SPI_GETNONCLIENTMETRICS, nm.cbSize, &mut nm as *mut _ as _, 0);
            let font = CreateFontIndirectW(&nm.lfMessageFont);
            let k = GetDpiForSystem().max(96) as f32 / 96.0;
            let s = |v: i32| (v as f32 * k).round() as i32;

            let width = s(440);
            let (m, cw) = (s(16), s(440) - 2 * s(16));
            let dc = GetDC(std::ptr::null_mut());
            let old = SelectObject(dc, font);
            let measure = |t: &str, wd: i32| { let t = w(t); let mut r = RECT { left: 0, top: 0, right: wd, bottom: 0 }; DrawTextW(dc, t.as_ptr(), -1, &mut r, DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX); r.bottom };
            let head_h = measure(text, cw);
            let line = measure("Ag", cw);
            SelectObject(dc, old);
            ReleaseDC(std::ptr::null_mut(), dc);

            let style = WS_CAPTION | WS_SYSMENU;
            let ex = WS_EX_TOPMOST | WS_EX_DLGMODALFRAME;
            let tw = w(title);
            let hwnd = CreateWindowExW(ex, class.as_ptr(), tw.as_ptr(), style, 0, 0, 100, 100, std::ptr::null_mut(), std::ptr::null_mut(), inst, std::ptr::null());
            if hwnd.is_null() { DeleteObject(font); return None; }
            let child = |cls: &str, t: &str, st: u32, ex: u32, x: i32, y: i32, cx: i32, cy: i32, id: usize| {
                let (c, t) = (w(cls), w(t));
                let h = CreateWindowExW(ex, c.as_ptr(), t.as_ptr(), WS_CHILD | WS_VISIBLE | st, x, y, cx, cy, hwnd, id as HMENU, inst, std::ptr::null());
                SendMessageW(h, WM_SETFONT, font as WPARAM, 1);
                h
            };

            let mut y = m;
            child("STATIC", text, SS_NOPREFIX, 0, m, y, cw, head_h, 0);
            y += head_h + s(14);
            let mut edits = vec![];
            for (i, f) in fields.iter().enumerate() {
                let label = if f.keep && f.secret { format!("{} (em branco: mantém o atual)", f.label) } else if f.optional { format!("{} (opcional)", f.label) } else { f.label.clone() };
                child("STATIC", &label, SS_NOPREFIX, 0, m, y, cw, line, 0);
                y += line + s(4);
                // várias linhas (chave PEM): caixa alta, sem •••, porque o Windows não esconde texto de várias linhas
                let multi = f.kind == "multiline";
                let eh = if multi { line * 6 + s(10) } else { line + s(10) };
                let st = if multi { ES_MULTILINE | ES_AUTOVSCROLL | ES_WANTRETURN | WS_VSCROLL } else { ES_AUTOHSCROLL | if f.secret { ES_PASSWORD } else { 0 } };
                let text = if multi { f.prefill.replace("\r\n", "\n").replace('\n', "\r\n") } else { f.prefill.clone() };
                let e = child("EDIT", &text, WS_TABSTOP | st, WS_EX_CLIENTEDGE, m, y, cw, eh, ID_EDIT + i);
                SendMessageW(e, EM_LIMITTEXT, 16_384, 0);
                if f.secret && !multi { SendMessageW(e, EM_SETPASSWORDCHAR, DOT, 0); }
                edits.push(e);
                y += eh + s(10);
            }
            let show = if fields.iter().any(|f| f.secret && f.kind != "multiline") {
                let h = child("BUTTON", "Mostrar o que eu digito", WS_TABSTOP | BS_AUTOCHECKBOX, 0, m, y, cw, line + s(4), ID_SHOW);
                y += line + s(4) + s(8);
                h
            } else { std::ptr::null_mut() };
            let err = child("STATIC", "", SS_NOPREFIX, 0, m, y, cw, line, ID_ERR);
            y += line + s(6);
            let (bw, bh) = (s(100), line + s(14));
            child("BUTTON", "Guardar", WS_TABSTOP | BS_DEFPUSHBUTTON, 0, width - m - 2 * bw - s(8), y, bw, bh, ID_OK);
            child("BUTTON", "Cancelar", WS_TABSTOP, 0, width - m - bw, y, bw, bh, ID_CANCEL);
            y += bh + m;

            let mut r = RECT { left: 0, top: 0, right: width, bottom: y };
            AdjustWindowRectEx(&mut r, style, 0, ex);
            let (ww, wh) = (r.right - r.left, r.bottom - r.top);
            SetWindowPos(hwnd, HWND_TOPMOST, (GetSystemMetrics(SM_CXSCREEN) - ww) / 2, (GetSystemMetrics(SM_CYSCREEN) - wh) / 3, ww, wh, 0);

            ST.with(|st| *st.borrow_mut() = Some(St { edits: edits.clone(), fields: fields.iter().map(|f| (f.optional, f.keep, f.kind.clone(), f.label.clone())).collect(), show, err, out: None }));
            ShowWindow(hwnd, SW_SHOW);
            SetForegroundWindow(hwnd);
            // o primeiro campo ainda vazio
            let first = fields.iter().position(|f| f.prefill.is_empty()).unwrap_or(0);
            if let Some(&e) = edits.get(first) { SetFocus(e); }

            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                // Tab entre os campos, Enter = Guardar, Esc = Cancelar
                if IsDialogMessageW(hwnd, &msg) == 0 { TranslateMessage(&msg); DispatchMessageW(&msg); }
            }
            DeleteObject(font);
            ST.with(|st| st.borrow_mut().take()).and_then(|st| st.out)
        }
    }
}

