//! Janela do aplicativo: uma janela nativa (tao) com WebView2 (wry), sem barra de navegador.
//! A página conversa com a janela por `window.ipc.postMessage(JSON)`: tema (cor da barra de título),
//! tela cheia (Apresentar) e DevTools. Também abre a janela do cofre para digitar um segredo (vault_input.rs).
use crate::server::{self, UiEvent};
use crate::util::*;
use serde_json::{Value, json};
use std::path::PathBuf;
use tao::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::{Fullscreen, Icon, Window, WindowBuilder, WindowId};
use wry::{NewWindowResponse, WebContext, WebViewBuilder};

/// Ipc(mensagem, endereço da página que mandou). Prompt: abrir a janela do cofre (pedido, canal da resposta);
/// PromptMsg: o que a página dela mandou; PromptShow: mostrá-la mesmo se a página demorar.
enum Ev { Activate, Quit, Notify(String, String), Ipc(String, String), Title(String), Show, Prompt(Value, std::sync::mpsc::Sender<Option<Vec<String>>>), PromptMsg(WindowId, String), PromptShow(WindowId) }
/// Uma janela do cofre aberta: a janela, a página e para quem responder.
type PromptWin = (Window, wry::WebView, std::sync::mpsc::Sender<Option<Vec<String>>>);
const PROMPT_W: f64 = 500.0;
/// No centro da janela do BlueScreen (ou da tela, se ela estiver escondida), um pouco acima do meio.
fn center_on(w: &Window, main: &Window, h: f64) {
    let s = w.scale_factor();
    let (pw, ph) = ((PROMPT_W * s) as i32, (h * s) as i32);
    if main.is_visible() && !main.is_minimized() {
        if let Ok(p) = main.outer_position() {
            let ms = main.outer_size();
            w.set_outer_position(PhysicalPosition::new(p.x + (ms.width as i32 - pw) / 2, p.y + ((ms.height as i32 - ph) / 3).max(0)));
            return;
        }
    }
    center(w, PROMPT_W, h);
}

/// "http://127.0.0.1:4747/x?y" -> "http://127.0.0.1:4747"; None para o que não tem origem (about:, data:, lixo)
fn origin_of(u: &str) -> Option<String> {
    reqwest::Url::parse(u).ok().map(|u| u.origin().ascii_serialization()).filter(|o| o != "null")
}

fn state_file() -> PathBuf { user_dir().join("window.json") }

/// Barra de título no tema da aplicação (Windows 11: cor da legenda; Windows 10: modo escuro).
#[cfg(windows)]
fn paint_titlebar(window: &Window, dark: bool, caption: Option<u32>) {
    use tao::platform::windows::WindowExtWindows;
    use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
    let hwnd = window.hwnd() as windows_sys::Win32::Foundation::HWND;
    unsafe {
        let d: i32 = dark as i32;
        DwmSetWindowAttribute(hwnd, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, &d as *const _ as _, 4);
        let round: u32 = 2; // DWMWCP_ROUND: cantos arredondados do Windows 11 também na janela sem moldura
        DwmSetWindowAttribute(hwnd, 33 /* DWMWA_WINDOW_CORNER_PREFERENCE */, &round as *const _ as _, 4);
        if let Some(c) = caption {
            DwmSetWindowAttribute(hwnd, 35 /* DWMWA_CAPTION_COLOR */, &c as *const _ as _, 4);
            DwmSetWindowAttribute(hwnd, 34 /* DWMWA_BORDER_COLOR */, &c as *const _ as _, 4);
            let text: u32 = if dark { 0x00E5E1DF } else { 0x00221F1E };
            DwmSetWindowAttribute(hwnd, 36 /* DWMWA_TEXT_COLOR */, &text as *const _ as _, 4);
        }
    }
}
#[cfg(not(windows))]
fn paint_titlebar(_: &Window, _: bool, _: Option<u32>) {}
/// "#RRGGBB" -> COLORREF (0x00BBGGRR)
fn colorref(hex: &str) -> Option<u32> {
    let h = hex.trim_start_matches('#');
    if h.len() != 6 { return None; }
    let v = u32::from_str_radix(h, 16).ok()?;
    Some(((v & 0xFF) << 16) | (v & 0xFF00) | ((v >> 16) & 0xFF))
}

/// Tamanho da janela de boas-vindas (sem projeto aberto), como a do IntelliJ: pequena e no centro da tela.
const WELCOME: (f64, f64) = (920.0, 620.0);
fn center(window: &Window, w: f64, h: f64) {
    if let Some(m) = window.current_monitor() {
        let (s, ms, mp) = (m.scale_factor(), m.size(), m.position());
        let (pw, ph) = ((w * s) as i32, (h * s) as i32);
        window.set_outer_position(PhysicalPosition::new(mp.x + (ms.width as i32 - pw) / 2, mp.y + (ms.height as i32 - ph) / 2));
    }
}

/// `doc`: janela leve de um documento (main.rs, --doc): título do arquivo, tamanho próprio (window.json, "doc") e
/// sem o modo de boas-vindas da IDE.
/// `studio`: janela do Estúdio (main.rs, --studio): só a janela, apontada para o BlueScreen que já está aberto; este
/// processo não tem servidor, então nada aqui pode consultar o estado dele.
pub fn run(url: String, devtools: bool, doc: Option<PathBuf>, studio: bool) -> ! {
    let event_loop = EventLoopBuilder::<Ev>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let p2 = proxy.clone();
    let _ = server::UI.set(Box::new(move |e| match e {
        UiEvent::Activate => { let _ = p2.send_event(Ev::Activate); }
        UiEvent::Quit => { let _ = p2.send_event(Ev::Quit); }
        UiEvent::Notify(t, b) => { let _ = p2.send_event(Ev::Notify(t, b)); }
        // sem a janela (o laço já acabou), o canal cai e o cofre entende como cancelado
        UiEvent::Prompt(spec, tx) => { let _ = p2.send_event(Ev::Prompt(spec, tx)); }
    }));

    let saved = read_json(&state_file());
    // a última sessão terminou sem projeto aberto: já nasce no tamanho de boas-vindas (sem piscar grande)
    let is_file = doc.is_some();
    let is_doc = is_file || studio;
    let key = if studio { "studio" } else { "doc" };
    let mut tray = if !is_doc { let p = proxy.clone(); crate::tray::Tray::new(move |quit| { let _ = p.send_event(if quit { Ev::Quit } else { Ev::Activate }); }) } else { None };
    // na primeira vez que a janela vai para a bandeja, um aviso diz onde ela foi parar e como sair de verdade
    const TRAY_HINT: (&str, &str) = ("O BlueScreen continua aberto", "Agenda e fluxos seguem rodando. Clique no ícone para voltar; botão direito para sair.");
    let mut tray_hint = false;
    let mut welcome = !is_doc && saved["welcome"].as_bool().unwrap_or(false);
    let sd = &saved[key];
    let (w, h) = if welcome { WELCOME } else if is_doc { (sd["w"].as_f64().unwrap_or(if studio { 1320.0 } else { 1180.0 }).max(640.0), sd["h"].as_f64().unwrap_or(if studio { 840.0 } else { 760.0 }).max(420.0)) }
        else { (saved["w"].as_f64().unwrap_or(1500.0).max(640.0), saved["h"].as_f64().unwrap_or(920.0).max(420.0)) };
    let title = doc.as_ref().and_then(|f| f.file_name()).map(|n| format!("{} - BlueScreen", n.to_string_lossy())).unwrap_or_else(|| if studio { "Estúdio - BlueScreen".into() } else { "BlueScreen".into() });
    let mut wb = WindowBuilder::new().with_title(&title).with_inner_size(LogicalSize::new(w, h)).with_min_inner_size(LogicalSize::new(640.0, 420.0))
        // nasce escondida: aparece quando a página já pintou a tela de abertura (mensagem "shown"), sem o clarão
        // da janela vazia enquanto o WebView2 sobe
        .with_maximized(!welcome && if is_doc { sd["max"].as_bool().unwrap_or(false) } else { saved["max"].as_bool().unwrap_or(false) }).with_visible(false)
        // sem a barra de título do Windows: a barra de cima do BlueScreen faz esse papel (arrastar, botões, bordas)
        .with_decorations(false);
    if let (false, false, Some(x), Some(y)) = (welcome, is_doc, saved["x"].as_i64(), saved["y"].as_i64()) { wb = wb.with_position(PhysicalPosition::new(x as i32, y as i32)); }
    #[cfg(windows)]
    {
        use tao::platform::windows::IconExtWindows;
        use tao::platform::windows::WindowBuilderExtWindows;
        if let Ok(icon) = Icon::from_resource(1, None) { wb = wb.with_window_icon(Some(icon)); }
        wb = wb.with_undecorated_shadow(true);
    }
    // sem console no executável de release: o erro aparece numa caixa de mensagem (fatal), não some
    let window = wb.build(&event_loop).unwrap_or_else(|e| crate::fatal(&format!("Não foi possível abrir a janela: {e}")));
    if welcome { center(&window, WELCOME.0, WELCOME.1); }
    if is_doc && !window.is_maximized() { center(&window, w, h); } // vários documentos abertos: cada um no centro
    // se a página demorar (WebView2 lento na primeira vez), a janela aparece assim mesmo
    { let p = proxy.clone(); std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_millis(1500)); let _ = p.send_event(Ev::Show); }); }
    let dark = saved["dark"].as_bool().unwrap_or(true);
    paint_titlebar(&window, dark, colorref(saved["caption"].as_str().unwrap_or(if dark { "#0F1A2E" } else { "#D9E3F5" })));

    let data = dirs::data_local_dir().unwrap_or_else(std::env::temp_dir).join("BlueScreen").join("WebView2");
    let mut ctx = WebContext::new(Some(data));
    // origem = esquema + host + porta, lidos da URL (comparar texto aceitaria "http://127.0.0.1:4747@outro.site")
    let origin = origin_of(&url).unwrap_or_default();
    let (o1, o2) = (origin.clone(), origin.clone());
    // espaço de trabalho de outro PC aberto nesta janela (Conectar, share.rs): as páginas dele também ficam aqui
    let remote: std::sync::Arc<std::sync::Mutex<Option<String>>> = Default::default();
    let (r1, r2) = (remote.clone(), remote.clone());
    let inside = |u: &str, o: &str, r: &std::sync::Mutex<Option<String>>| { let uo = origin_of(u); uo.as_deref() == Some(o) || r.lock().unwrap_or_else(|e| e.into_inner()).as_deref().is_some_and(|r| uo.is_some() && uo == origin_of(r)) };
    let (pi, pt) = (proxy.clone(), proxy.clone());
    let builder = WebViewBuilder::new_with_web_context(&mut ctx)
        .with_url(&url)
        .with_devtools(devtools)
        .with_hotkeys_zoom(false) // Ctrl+roda é o zoom da fonte do código; o tamanho da interface fica em Aparência
        .with_background_color(if dark { (15, 26, 46, 255) } else { (217, 227, 245, 255) })
        .with_initialization_script(format!("window.BS_DESKTOP = true; window.BS_MAX = {}; window.BS_WELCOME = {}; window.BS_DOC = {}; window.BS_STUDIO = {};", window.is_maximized(), welcome, is_file, studio))
        .with_ipc_handler(move |req| { let _ = pi.send_event(Ev::Ipc(req.body().clone(), req.uri().to_string())); })
        .with_document_title_changed_handler(move |t| { let _ = pt.send_event(Ev::Title(t)); })
        // links para fora abrem no navegador; janelas do próprio app (páginas servidas pelo BlueScreen) abrem aqui
        .with_new_window_req_handler(move |u, _| { if inside(&u, &o1, &r1) { NewWindowResponse::Allow } else { open_url(&u); NewWindowResponse::Deny } })
        .with_navigation_handler(move |u| { if inside(&u, &o2, &r2) || u.starts_with("about:") || u.starts_with("data:") { true } else { open_url(&u); false } });
    #[cfg(windows)]
    let builder = {
        use wry::WebViewBuilderExtWindows;
        // F5, Ctrl+P, Ctrl+F... são atalhos do BlueScreen, não do navegador
        builder.with_browser_accelerator_keys(false).with_default_context_menus(devtools)
    };
    let webview = builder.build(&window).unwrap_or_else(|e| crate::fatal(&format!("Não foi possível iniciar o WebView2: {e}\n\nInstale o Microsoft Edge WebView2 Runtime (https://go.microsoft.com/fwlink/p/?LinkId=2124703) e abra o BlueScreen de novo.")));

    // na tela de boas-vindas o tamanho da janela não é guardado: o que vale é o da IDE, restaurado ao abrir um projeto
    let save_state = move |window: &Window, dark: bool, caption: &str, welcome: bool| {
        let max = window.is_maximized();
        let mut j = read_json(&state_file());
        if !j.is_object() { j = json!({}); }
        // janela de documento: guarda só o tamanho dela, sem mexer no da IDE
        if is_doc {
            let mut d = json!({ "max": max });
            if max { d["w"] = j[key]["w"].clone(); d["h"] = j[key]["h"].clone(); }
            else { let sz: LogicalSize<f64> = window.inner_size().to_logical(window.scale_factor()); d["w"] = json!(sz.width); d["h"] = json!(sz.height); }
            j[key] = d; j["dark"] = json!(dark); j["caption"] = json!(caption);
            let _ = write_atomic(&state_file(), &j.to_string()); return;
        }
        j["welcome"] = json!(welcome);
        if welcome { j["dark"] = json!(dark); j["caption"] = json!(caption); let _ = write_atomic(&state_file(), &j.to_string()); return; }
        if !max {
            let sz: LogicalSize<f64> = window.inner_size().to_logical(window.scale_factor());
            j["w"] = json!(sz.width); j["h"] = json!(sz.height);
            if let Ok(p) = window.outer_position() { j["x"] = json!(p.x); j["y"] = json!(p.y); }
        }
        j["max"] = json!(max); j["dark"] = json!(dark); j["caption"] = json!(caption);
        let _ = write_atomic(&state_file(), &j.to_string());
    };
    let mut dark = dark;
    let mut caption = saved["caption"].as_str().unwrap_or("#0F1A2E").to_string();
    let mut ctx = ctx;
    let mut prompts: std::collections::HashMap<WindowId, PromptWin> = Default::default();

    event_loop.run(move |event, target, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(Ev::Notify(t,b)) => { if let Some(tray) = &tray { tray.notify(&t,&b); } }
            Event::UserEvent(Ev::Quit) => {
                // A página faz a mesma verificação de documentos não salvos do botão fechar.
                window.set_visible(true); window.set_minimized(false); window.set_focus();
                let _ = webview.evaluate_script("window.BS_APP_QUIT && BS_APP_QUIT()");
            }
            // ---------- janela do cofre ----------
            Event::UserEvent(Ev::Prompt(spec, tx)) => {
                // altura aproximada até a página medir a dela (mensagem "ready")
                let h = 250.0 + spec["fields"].as_array().map(|a| a.iter().map(|f| if f["kind"] == "multiline" { 160.0 } else { 74.0 }).sum::<f64>()).unwrap_or(74.0);
                let mut wb = WindowBuilder::new().with_title("BlueScreen · Cofre").with_inner_size(LogicalSize::new(PROMPT_W, h))
                    .with_resizable(false).with_minimizable(false).with_maximizable(false).with_always_on_top(true).with_visible(false);
                #[cfg(windows)]
                {
                    use tao::platform::windows::IconExtWindows;
                    if let Ok(icon) = Icon::from_resource(1, None) { wb = wb.with_window_icon(Some(icon)); }
                }
                let Ok(pw) = wb.build(target) else { return };
                paint_titlebar(&pw, dark, colorref(&caption));
                center_on(&pw, &window, h);
                let id = pw.id();
                let pm = proxy.clone();
                let b = WebViewBuilder::new_with_web_context(&mut ctx)
                    .with_html(crate::plugins::vault_input::html(&spec, dark))
                    .with_devtools(false)
                    .with_hotkeys_zoom(false)
                    .with_background_color(if dark { (30, 33, 41, 255) } else { (248, 249, 251, 255) })
                    .with_ipc_handler(move |req| { let _ = pm.send_event(Ev::PromptMsg(id, req.body().clone())); })
                    // a página é só esta: nada de navegar nem abrir outras
                    .with_navigation_handler(|u| u.starts_with("about:") || u.starts_with("data:"))
                    .with_new_window_req_handler(|_, _| NewWindowResponse::Deny);
                #[cfg(windows)]
                let b = { use wry::WebViewBuilderExtWindows; b.with_browser_accelerator_keys(false).with_default_context_menus(false) };
                let Ok(wv) = b.build(&pw) else { return };
                { let p = proxy.clone(); std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_millis(1500)); let _ = p.send_event(Ev::PromptShow(id)); }); }
                prompts.insert(id, (pw, wv, tx));
            }
            Event::UserEvent(Ev::PromptShow(id)) => if let Some((pw, ..)) = prompts.get(&id) { if !pw.is_visible() { pw.set_visible(true); pw.set_focus(); } },
            Event::UserEvent(Ev::PromptMsg(id, msg)) => {
                let m: Value = serde_json::from_str(&msg).unwrap_or(Value::Null);
                match m["type"].as_str() {
                    Some("ready") => if let Some((pw, wv, _)) = prompts.get(&id) {
                        let h = m["h"].as_f64().unwrap_or(400.0).clamp(200.0, 900.0);
                        pw.set_inner_size(LogicalSize::new(PROMPT_W, h));
                        center_on(pw, &window, h);
                        pw.set_visible(true); pw.set_focus(); let _ = wv.focus();
                    },
                    Some("ok") => if let Some((_, _, tx)) = prompts.remove(&id) {
                        let vals: Vec<String> = m["values"].as_array().map(|a| a.iter().map(|v| v.as_str().unwrap_or("").to_string()).collect()).unwrap_or_default();
                        let _ = tx.send(Some(vals));
                    },
                    Some("cancel") => if let Some((_, _, tx)) = prompts.remove(&id) { let _ = tx.send(None); },
                    _ => {}
                }
            }
            Event::WindowEvent { window_id, event: WindowEvent::CloseRequested, .. } if prompts.contains_key(&window_id) => {
                if let Some((_, _, tx)) = prompts.remove(&window_id) { let _ = tx.send(None); }
            }
            Event::WindowEvent { window_id, .. } if prompts.contains_key(&window_id) => {}
            Event::UserEvent(Ev::Activate) => {
                window.set_visible(true); window.set_minimized(false);
                // sobe por cima das outras janelas mesmo se o Windows negar o foco
                window.set_always_on_top(true); window.set_always_on_top(false); window.set_focus();
            }
            Event::UserEvent(Ev::Show) => if !window.is_visible() { window.set_visible(true); window.set_focus(); },
            Event::UserEvent(Ev::Title(t)) => window.set_title(&t),
            Event::UserEvent(Ev::Ipc(msg, from)) => {
                let m: Value = serde_json::from_str(&msg).unwrap_or(Value::Null);
                match m["type"].as_str() {
                    // só a página local escolhe para onde conectar (o endereço já foi conferido por /api/network/probe)
                    Some("connect") if origin_of(&from).as_deref() == Some(origin.as_str()) => if let Some(u) = m["url"].as_str().filter(|u| u.starts_with("http://")) {
                        let u = u.trim_end_matches('/').to_string();
                        log(format!("Conectando ao espaço de trabalho {u}"));
                        *remote.lock().unwrap_or_else(|e| e.into_inner()) = Some(u.clone());
                        let _ = webview.load_url(&format!("{u}/"));
                    },
                    Some("disconnect") => {
                        log("Voltando ao espaço de trabalho deste PC.");
                        let _ = webview.load_url(&url);
                        *remote.lock().unwrap_or_else(|e| e.into_inner()) = None;
                    }
                    Some("shown") => if !window.is_visible() { window.set_visible(true); window.set_focus(); },
                    Some("theme") => {
                        dark = m["dark"].as_bool().unwrap_or(true);
                        if let Some(c) = m["caption"].as_str() { caption = c.to_string(); }
                        paint_titlebar(&window, dark, colorref(&caption));
                    }
                    Some("fullscreen") => window.set_fullscreen(if m["on"].as_bool().unwrap_or(false) { Some(Fullscreen::Borderless(None)) } else { None }),
                    Some("devtools") if devtools => webview.open_devtools(),
                    // barra de título própria
                    Some("drag") => { let _ = window.drag_window(); }
                    Some("resize") if !welcome => {
                        use tao::window::ResizeDirection as R;
                        let d = match m["dir"].as_str().unwrap_or("") { "n" => R::North, "s" => R::South, "e" => R::East, "w" => R::West, "ne" => R::NorthEast, "nw" => R::NorthWest, "se" => R::SouthEast, _ => R::SouthWest };
                        if !window.is_maximized() { let _ = window.drag_resize_window(d); }
                    }
                    Some("zoom") => { let _ = webview.zoom(m["factor"].as_f64().unwrap_or(1.0).clamp(0.6, 2.0)); }
                    Some("min") => window.set_minimized(true),
                    // a IDE sai da frente quando o Estúdio abre; volta pela bandeja ou pelo "Abrir a IDE" de lá
                    Some("hide") if !is_doc => window.set_visible(false),
                    Some("focus") => { window.set_visible(true); window.set_minimized(false); window.set_always_on_top(true); window.set_always_on_top(false); window.set_focus(); }
                    Some("max") if !welcome => window.set_maximized(!window.is_maximized()),
                    Some("welcome") if !is_doc => {
                        let on = m["on"].as_bool().unwrap_or(false);
                        if on != welcome {
                            if on {
                                save_state(&window, dark, &caption, false);
                                welcome = true;
                                window.set_maximized(false);
                                window.set_inner_size(LogicalSize::new(WELCOME.0, WELCOME.1));
                                center(&window, WELCOME.0, WELCOME.1);
                            } else {
                                welcome = false;
                                let j = read_json(&state_file());
                                let (w, h) = (j["w"].as_f64().unwrap_or(1500.0).max(640.0), j["h"].as_f64().unwrap_or(920.0).max(420.0));
                                window.set_inner_size(LogicalSize::new(w, h));
                                match (j["x"].as_i64(), j["y"].as_i64()) { (Some(x), Some(y)) => window.set_outer_position(PhysicalPosition::new(x as i32, y as i32)), _ => center(&window, w, h) }
                                if j["max"].as_bool().unwrap_or(false) { window.set_maximized(true); }
                            }
                            save_state(&window, dark, &caption, welcome);
                        }
                    }
                    Some("close") => {
                        save_state(&window, dark, &caption, welcome);
                        if !is_doc && let Some(t) = &tray { window.set_visible(false); if !tray_hint { tray_hint = true; t.notify(TRAY_HINT.0, TRAY_HINT.1); } }
                        else if !studio && server::lan_enabled() { log("Janela fechada; servidor continua por causa da rede local."); window.set_visible(false); }
                        else { log("Janela fechada. Encerrando."); *flow = ControlFlow::Exit; }
                    }
                    Some("quit") if origin_of(&from).as_deref() == Some(origin.as_str()) => { save_state(&window, dark, &caption, welcome); *flow = ControlFlow::Exit; }
                    _ => {}
                }
            }
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                // documento: a página fecha (e pergunta antes, se houver alteração não salva)
                if is_doc { let _ = webview.evaluate_script("window.BS_DOC_CLOSE ? BS_DOC_CLOSE() : window.ipc.postMessage('{\"type\":\"close\"}')"); return; }
                save_state(&window, dark, &caption, welcome);
                if tray.is_some() || server::lan_enabled() {
                    // com o ícone na bandeja (ou a rede local ligada) o BlueScreen continua: agenda, fluxos e servidor seguem
                    log("Janela fechada; o BlueScreen continua na bandeja.");
                    window.set_visible(false);
                    if let Some(t) = &tray && !tray_hint { tray_hint = true; t.notify(TRAY_HINT.0, TRAY_HINT.1); }
                } else {
                    log("Janela fechada. Encerrando.");
                    *flow = ControlFlow::Exit;
                }
            }
            Event::WindowEvent { event: WindowEvent::Resized(PhysicalSize { .. }), .. } => {
                // a página troca o ícone de maximizar e esconde as bordas de redimensionar
                let _ = webview.evaluate_script(&format!("window.BS_WIN && BS_WIN.max({})", window.is_maximized()));
            }
            Event::LoopDestroyed => { drop(tray.take()); drop(prompts.drain().collect::<Vec<_>>()); std::process::exit(0); },
            _ => {}
        }
    })
}

#[cfg(test)]
mod tests {
    use super::origin_of;
    #[test]
    fn origens() {
        assert_eq!(origin_of("http://127.0.0.1:4747/").as_deref(), Some("http://127.0.0.1:4747"));
        assert_eq!(origin_of("http://127.0.0.1:4747/?doc=C%3A%5Ca.csv").as_deref(), Some("http://127.0.0.1:4747"));
        assert_eq!(origin_of("http://127.0.0.1:4747@evil.com/").as_deref(), Some("http://evil.com"));
        assert_eq!(origin_of("http://127.0.0.1:47470/").as_deref(), Some("http://127.0.0.1:47470"));
        assert_eq!(origin_of("about:blank"), None);
    }
}
