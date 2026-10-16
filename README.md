# Teste de áudio longo em web app — iOS

Página de teste autocontida para medir, num iPhone real, o que um web app
entrega de áudio de 25+ minutos — e o que não entrega.

Instruções de uso: **[COMO-RODAR.md](COMO-RODAR.md)**

Os 8 testes: áudio com a tela bloqueada sem e com Wake Lock, botão de
silencioso, Media Session, cota real de armazenamento, download para IndexedDB
com reprodução offline, web push em PWA instalada, e sobrevivência do
armazenamento a 7 dias de inatividade.

Sem build e sem framework. Log persistente em IndexedDB para sobreviver ao
bloqueio de tela. Áudio de teste: 27 min, 96 kbps mono, com marcação falada a
cada minuto.
