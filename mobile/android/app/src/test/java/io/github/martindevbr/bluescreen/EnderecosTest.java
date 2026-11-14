package io.github.martindevbr.bluescreen;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class EnderecosTest {
    @Test
    public void aceitaOsJeitosDeDigitar() {
        assertEquals("http://192.168.0.10:4748", Enderecos.normalizar("192.168.0.10"));
        assertEquals("http://192.168.0.10:4748", Enderecos.normalizar("  192.168.0.10  "));
        assertEquals("http://192.168.0.10:5000", Enderecos.normalizar("192.168.0.10:5000"));
        assertEquals("http://10.0.2.2:4748", Enderecos.normalizar("http://10.0.2.2:4748/instalar"));
        assertEquals("http://10.0.2.2:4748", Enderecos.normalizar("HTTP://10.0.2.2:4748/?x=1"));
        assertEquals("http://172.16.5.1:4748", Enderecos.normalizar("172.16.5.1/"));
    }

    @Test
    public void recusaOQueOServidorTambemRecusa() {
        assertNull(Enderecos.normalizar(null));
        assertNull(Enderecos.normalizar(""));
        assertNull(Enderecos.normalizar("meupc.local"));
        assertNull(Enderecos.normalizar("https://192.168.0.10"));
        assertNull(Enderecos.normalizar("javascript:alert(1)"));
        assertNull(Enderecos.normalizar("192.168.0.256"));
        assertNull(Enderecos.normalizar("192.168.0"));
        assertNull(Enderecos.normalizar("192.168.00.1"));
        assertNull(Enderecos.normalizar("192.168.0.10:"));
        assertNull(Enderecos.normalizar("192.168.0.10:99999"));
        assertNull(Enderecos.normalizar("user@192.168.0.10"));
        assertNull(Enderecos.normalizar("0.0.0.0"));
    }

    @Test
    public void origemDeUmaUrl() {
        assertEquals("http://192.168.0.10:4748", Enderecos.origem("http://192.168.0.10:4748/api/session"));
        assertNull(Enderecos.origem("file:///android_asset/conectar.html"));
        assertNull(Enderecos.origem("https://github.com/martindevbr"));
    }
}
