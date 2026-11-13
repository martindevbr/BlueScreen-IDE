# Agenda

Compromissos e lembretes, com o mês, os próximos 14 dias e os compromissos do Google Agenda e do Outlook junto dos seus. Na hora marcada (ou alguns minutos antes) chega um aviso do Windows, mesmo com o BlueScreen na bandeja. Um compromisso pode repetir e pode rodar um fluxo do Automator.

- Abre pelo rodapé, no meio da tela.
- Compromisso novo em uma linha: `Reunião amanhã 14h`, `Dentista sexta às 15h`, `Tomar água em 30 min`.
- **Conectar agenda:** cole o link ICS do Google Agenda, do Outlook ou de qualquer outra agenda. É só leitura; o link fica cifrado (`plugin.secrets`).
- **Enviar para…:** abre o compromisso no Google Agenda ou no Outlook, já preenchido, ou grava um `.ics`.

Veja [Agenda](../../../docs/AUTOMACOES.md#agenda).

## Testes

```
node app/plugins/agenda/tests/ics.test.js
```

Cobrem o leitor de `.ics` (fusos do IANA e do Windows, VTIMEZONE, dia inteiro, RRULE, EXDATE, RECURRENCE-ID) e o texto em uma linha.
