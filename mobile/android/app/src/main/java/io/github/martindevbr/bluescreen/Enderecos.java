package io.github.martindevbr.bluescreen;

/**
 * Endereço do BlueScreen no PC. A rede local do BlueScreen só aceita o IP escrito (um nome como meupc.local é
 * recusado pelo servidor, contra DNS rebinding), então o app também só aceita IP: "192.168.0.10",
 * "192.168.0.10:4748" ou "http://192.168.0.10:4748/qualquer/coisa" viram "http://192.168.0.10:4748".
 * Java puro (sem android.*), para o teste rodar na JVM.
 */
public final class Enderecos {
    /** porta da rede local do BlueScreen (BLUESCREEN_LAN_PORT muda no PC; aí a pessoa digita a porta) */
    public static final int PORTA = 4748;

    private Enderecos() {}

    /** Origem "http://ip:porta", ou null se não for um endereço aceito. */
    public static String normalizar(String bruto) {
        if (bruto == null) return null;
        String s = bruto.trim();
        if (s.isEmpty()) return null;
        String lower = s.toLowerCase(java.util.Locale.ROOT);
        if (lower.startsWith("http://")) s = s.substring(7);
        else if (lower.contains("://")) return null; // https, ftp...: o BlueScreen da rede local é só HTTP
        int barra = s.indexOf('/');
        if (barra >= 0) s = s.substring(0, barra);
        int q = s.indexOf('?');
        if (q >= 0) s = s.substring(0, q);
        if (s.contains("@")) return null;
        String host = s;
        int porta = PORTA;
        int dois = s.lastIndexOf(':');
        if (dois >= 0) {
            host = s.substring(0, dois);
            String p = s.substring(dois + 1);
            if (p.isEmpty() || p.length() > 5 || !p.chars().allMatch(Character::isDigit)) return null;
            porta = Integer.parseInt(p);
            if (porta < 1 || porta > 65535) return null;
        }
        if (!ipv4(host)) return null;
        return "http://" + host + ":" + porta;
    }

    /** "a.b.c.d" com cada parte de 0 a 255, sem zeros à esquerda (que alguns sistemas leem como octal). */
    public static boolean ipv4(String h) {
        String[] p = h.split("\\.", -1);
        if (p.length != 4) return false;
        for (String x : p) {
            if (x.isEmpty() || x.length() > 3 || !x.chars().allMatch(Character::isDigit)) return false;
            if (x.length() > 1 && x.charAt(0) == '0') return false;
            if (Integer.parseInt(x) > 255) return false;
        }
        return !h.equals("0.0.0.0") && !h.startsWith("255.");
    }

    /** a origem de uma URL qualquer ("http://1.2.3.4:4748/api/x" -> "http://1.2.3.4:4748"), ou null */
    public static String origem(String url) {
        if (url == null || !url.toLowerCase(java.util.Locale.ROOT).startsWith("http://")) return null;
        return normalizar(url);
    }
}
