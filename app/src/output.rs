//! Saída de programas (build, instalações, atualização, plugins, servidores de linguagem): um leitor de linhas só,
//! que aguenta o que os programas do Windows escrevem de verdade.
//! - Linha que não é UTF-8 válido (cmd, javac, MSBuild, programas em C) é lida pela code page do console (OEM,
//!   850 no Windows em português) ou pela do sistema (ANSI, 1252): fica com os acentos certos em vez de "�".
//! - `\r` sozinho também quebra a linha: barras de progresso (pip, npm, cargo, curl) viram uma linha por passo em
//!   vez de uma linha gigante que só aparece no fim.
//! - Linha sem fim (um programa que nunca escreve `\n`) é entregue em pedaços de MAX_LINE bytes: a memória não cresce.

/// maior linha entregue de uma vez (o resto vem na próxima)
pub const MAX_LINE: usize = 64 * 1024;

/// Bytes da saída de um programa como texto: UTF-8 se for válido; senão, a code page que fizer mais sentido.
pub fn decode_console(b: &[u8]) -> String {
    match std::str::from_utf8(b) { Ok(s) => s.to_string(), Err(_) => decode_codepage(b) }
}

#[cfg(windows)]
fn decode_codepage(b: &[u8]) -> String {
    use windows_sys::Win32::Globalization::{GetACP, GetOEMCP, MultiByteToWideChar};
    let conv = |cp: u32| -> Option<String> {
        let len = i32::try_from(b.len()).ok()?;
        let n = unsafe { MultiByteToWideChar(cp, 0, b.as_ptr(), len, std::ptr::null_mut(), 0) };
        if n <= 0 { return None; }
        let mut w = vec![0u16; n as usize];
        let n = unsafe { MultiByteToWideChar(cp, 0, b.as_ptr(), len, w.as_mut_ptr(), n) };
        (n > 0).then(|| String::from_utf16_lossy(&w[..n as usize]))
    };
    // OEM (850) e ANSI (1252) leem qualquer byte, mas só uma acerta as letras: "ação" em 1252 é E7 E3, em 850 é
    // 87 C6. Fica a que der mais letras fora do ASCII (a errada vira desenho de caixa e símbolos).
    let letters = |s: &str| s.chars().filter(|c| !c.is_ascii() && c.is_alphabetic()).count();
    let (oem, ansi) = (conv(unsafe { GetOEMCP() }), conv(unsafe { GetACP() }));
    match (oem, ansi) {
        (Some(o), Some(a)) => if letters(&a) > letters(&o) { a } else { o },
        (Some(x), None) | (None, Some(x)) => x,
        (None, None) => String::from_utf8_lossy(b).into_owned(),
    }
}
#[cfg(not(windows))]
fn decode_codepage(b: &[u8]) -> String { String::from_utf8_lossy(b).into_owned() }

/// Estado comum dos dois leitores: o pedaço da linha atual e se o próximo `\n` fecha um `\r` já entregue.
#[derive(Default)]
struct Split { pend: Vec<u8>, skip_lf: bool }
impl Split {
    /// Consome de `avail` até a próxima quebra. Devolve (bytes consumidos, linha pronta para `take`?).
    fn step(&mut self, avail: &[u8]) -> (usize, bool) {
        if self.skip_lf {
            self.skip_lf = false;
            if avail.first() == Some(&b'\n') { return (1, false); }
        }
        match memchr::memchr2(b'\n', b'\r', avail) {
            Some(p) if self.pend.len() + p <= MAX_LINE => { self.pend.extend_from_slice(&avail[..p]); self.skip_lf = avail[p] == b'\r'; (p + 1, true) }
            _ => {
                let n = avail.len().min(MAX_LINE - self.pend.len());
                self.pend.extend_from_slice(&avail[..n]);
                (n, self.pend.len() >= MAX_LINE)
            }
        }
    }
    /// A linha juntada até aqui. Cortada no limite no meio de um caractere UTF-8: o pedaço do caractere fica para a
    /// próxima (senão a linha inteira pareceria não ser UTF-8).
    fn take(&mut self) -> String {
        let keep = match std::str::from_utf8(&self.pend) { Err(e) if e.error_len().is_none() && self.pend.len() >= MAX_LINE => self.pend.len() - e.valid_up_to(), _ => 0 };
        let rest = self.pend.split_off(self.pend.len() - keep);
        let line = decode_console(&self.pend);
        self.pend = rest;
        line
    }
}

/// Linhas de um leitor assíncrono (stdout/stderr de um processo do tokio). Sem o `\n`/`\r` do fim.
pub struct Lines<R> { r: tokio::io::BufReader<R>, s: Split }
impl<R: tokio::io::AsyncRead + Unpin> Lines<R> {
    pub fn new(r: R) -> Self { Lines { r: tokio::io::BufReader::new(r), s: Split::default() } }
    /// Próxima linha; None no fim da saída (ou num erro de leitura).
    pub async fn next(&mut self) -> Option<String> {
        use tokio::io::AsyncBufReadExt;
        loop {
            let avail = self.r.fill_buf().await.unwrap_or_default();
            if avail.is_empty() { return if self.s.pend.is_empty() { None } else { Some(self.s.take()) }; }
            let (n, done) = self.s.step(avail);
            self.r.consume(n);
            if done { return Some(self.s.take()); }
        }
    }
}

/// O mesmo, para leitura sem tokio (threads).
pub struct LinesSync<R> { r: std::io::BufReader<R>, s: Split }
impl<R: std::io::Read> LinesSync<R> {
    pub fn new(r: R) -> Self { LinesSync { r: std::io::BufReader::new(r), s: Split::default() } }
}
impl<R: std::io::Read> Iterator for LinesSync<R> {
    type Item = String;
    fn next(&mut self) -> Option<String> {
        use std::io::BufRead;
        loop {
            let avail = self.r.fill_buf().unwrap_or_default();
            if avail.is_empty() { return if self.s.pend.is_empty() { None } else { Some(self.s.take()) }; }
            let (n, done) = self.s.step(avail);
            self.r.consume(n);
            if done { return Some(self.s.take()); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn all(b: &[u8]) -> Vec<String> { LinesSync::new(b).collect() }
    #[test]
    fn quebras() {
        assert_eq!(all(b"a\nb\r\nc"), ["a", "b", "c"]);
        // barra de progresso: cada \r é um passo
        assert_eq!(all(b"10%\r20%\r30%\ndone\n"), ["10%", "20%", "30%", "done"]);
        assert_eq!(all(b"\n\n"), ["", ""]);
        assert!(all(b"").is_empty());
    }
    #[test]
    fn linha_comprida() {
        let big = vec![b'x'; MAX_LINE * 2 + 10];
        let v = all(&big);
        assert_eq!(v.iter().map(|s| s.len()).collect::<Vec<_>>(), [MAX_LINE, MAX_LINE, 10]);
        // corte no meio de um caractere de 2 bytes: ele vai inteiro para o pedaço seguinte
        let mut b = vec![b'x'; MAX_LINE - 1]; b.extend_from_slice("ç!".as_bytes());
        let v = all(&b);
        assert_eq!(v[0].len(), MAX_LINE - 1);
        assert_eq!(v[1], "ç!");
    }
    #[test]
    fn nao_utf8() {
        // não é UTF-8: nada de "�"; a linha seguinte em UTF-8 continua normal
        let v = all(b"a\xE7\xE3o\nok \xC3\xA7\n");
        assert!(!v[0].contains('\u{FFFD}'));
        assert_eq!(v[1], "ok ç");
    }
}
