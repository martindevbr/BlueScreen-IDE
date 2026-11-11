//! Ícone nativo da área de notificação, com restaurar, sair e lembretes.
#[cfg(windows)]
mod win {
    use std::sync::{Arc, OnceLock};
    use windows_sys::Win32::{
        Foundation::*,
        System::LibraryLoader::GetModuleHandleW,
        UI::{Shell::*, WindowsAndMessaging::*},
    };
    const CALLBACK: u32 = WM_APP + 41;
    static ACTION: OnceLock<Arc<dyn Fn(bool) + Send + Sync>> = OnceLock::new();
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    unsafe fn data(hwnd: HWND) -> NOTIFYICONDATAW {
        let mut d: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
        d.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
        d.hWnd = hwnd;
        d.uID = 1;
        d
    }
    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        unsafe {
            if msg == CALLBACK {
                match l as u32 {
                    WM_LBUTTONUP | WM_LBUTTONDBLCLK | NIN_BALLOONUSERCLICK => {
                        if let Some(f) = ACTION.get() {
                            f(false);
                        }
                    }
                    WM_RBUTTONUP | WM_CONTEXTMENU => {
                        let menu = CreatePopupMenu();
                        AppendMenuW(menu, MF_STRING, 1, wide("Abrir BlueScreen").as_ptr());
                        AppendMenuW(menu, MF_STRING, 2, wide("Sair do BlueScreen").as_ptr());
                        let mut p: POINT = std::mem::zeroed();
                        GetCursorPos(&mut p);
                        SetForegroundWindow(hwnd);
                        let choice = TrackPopupMenu(
                            menu,
                            TPM_RETURNCMD | TPM_NONOTIFY,
                            p.x,
                            p.y,
                            0,
                            hwnd,
                            std::ptr::null(),
                        );
                        // sem esta mensagem, o menu pode não fechar ao clicar fora dele (comportamento documentado do TrackPopupMenu)
                        PostMessageW(hwnd, WM_NULL, 0, 0);
                        DestroyMenu(menu);
                        if choice != 0 {
                            if let Some(f) = ACTION.get() {
                                f(choice == 2);
                            }
                        }
                    }
                    _ => {}
                }
                return 0;
            }
            if msg == WM_DESTROY {
                Shell_NotifyIconW(NIM_DELETE, &data(hwnd));
                return 0;
            }
            // Explorer reiniciado: registra novamente o ícone.
            static TASKBAR_CREATED: OnceLock<u32> = OnceLock::new();
            if msg == *TASKBAR_CREATED.get_or_init(|| RegisterWindowMessageW(wide("TaskbarCreated").as_ptr())) {
                add(hwnd);
                return 0;
            }
            DefWindowProcW(hwnd, msg, w, l)
        }
    }
    unsafe fn add(hwnd: HWND) -> bool {
        unsafe {
            let mut d = data(hwnd);
            d.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
            d.uCallbackMessage = CALLBACK;
            d.hIcon = LoadIconW(GetModuleHandleW(std::ptr::null()), 1usize as _);
            if d.hIcon.is_null() {
                d.hIcon = LoadIconW(std::ptr::null_mut(), IDI_APPLICATION);
            }
            for (a, b) in d
                .szTip
                .iter_mut()
                .zip(wide("BlueScreen — clique para abrir"))
            {
                *a = b;
            }
            Shell_NotifyIconW(NIM_ADD, &d) != 0
        }
    }
    pub struct Tray {
        hwnd: HWND,
    }
    impl Tray {
        pub fn new(f: impl Fn(bool) + Send + Sync + 'static) -> Option<Self> {
            let _ = ACTION.set(Arc::new(f));
            unsafe {
                let class = wide("BlueScreenNotificationArea");
                let instance = GetModuleHandleW(std::ptr::null());
                let wc = WNDCLASSW {
                    lpfnWndProc: Some(proc),
                    hInstance: instance,
                    lpszClassName: class.as_ptr(),
                    ..std::mem::zeroed()
                };
                RegisterClassW(&wc);
                let hwnd = CreateWindowExW(
                    0,
                    class.as_ptr(),
                    class.as_ptr(),
                    0,
                    0,
                    0,
                    0,
                    0,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    instance,
                    std::ptr::null(),
                );
                if hwnd.is_null() {
                    return None;
                }
                if !add(hwnd) {
                    DestroyWindow(hwnd);
                    return None;
                }
                Some(Self { hwnd })
            }
        }
        pub fn notify(&self, title: &str, message: &str) {
            unsafe {
                let mut d = data(self.hwnd);
                d.uFlags = NIF_INFO;
                d.dwInfoFlags = NIIF_INFO;
                for (a, b) in d.szInfoTitle.iter_mut().take(63).zip(title.encode_utf16()) {
                    *a = b;
                }
                for (a, b) in d.szInfo.iter_mut().take(255).zip(message.encode_utf16()) {
                    *a = b;
                }
                Shell_NotifyIconW(NIM_MODIFY, &d);
            }
        }
    }
    impl Drop for Tray {
        fn drop(&mut self) {
            unsafe {
                Shell_NotifyIconW(NIM_DELETE, &data(self.hwnd));
                DestroyWindow(self.hwnd);
            }
        }
    }
}
#[cfg(windows)]
pub use win::Tray;
#[cfg(not(windows))]
pub struct Tray;
#[cfg(not(windows))]
impl Tray {
    pub fn new(_: impl Fn(bool) + Send + Sync + 'static) -> Option<Self> {
        None
    }
    pub fn notify(&self, _: &str, _: &str) {}
}
