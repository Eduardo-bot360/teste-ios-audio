# Como rodar o teste no iPhone

A página mede o que um web app entrega de áudio longo no iOS. São 8 testes.
Os de áudio levam ~26 min cada; o teste 8 leva 7 dias e você só confere depois.

O áudio de teste fala **"minuto N" a cada minuto** sobre um tom suave. Se o áudio
parar, você ouve onde parou — e o log registra o segundo exato.

---

## 1. Abrir a página

**https://eduardo-bot360.github.io/teste-ios-audio/**

URL fixa, no ar, HTTPS. Serve para os 8 testes. Não precisa ligar nada nesta
máquina — abra direto no Safari do iPhone.

<details>
<summary>Alternativa: rodar da sua máquina por túnel</summary>

Só se você quiser testar uma alteração antes de publicar. Dois comandos, cada um
na sua aba:

```bash
python3 "/Users/eduardo/APP LIVROS/teste-ios/servidor.py" 8787
```

```bash
cloudflared tunnel --url http://localhost:8787
```

O segundo imprime uma URL `https://....trycloudflare.com`.

**Não use o túnel para o teste 8.** A URL muda a cada reinício, e o IndexedDB é
preso à origem — origem nova, dados zerados.

Para publicar uma alteração na URL fixa:

```bash
cd "/Users/eduardo/APP LIVROS/teste-ios" && git add -A && git commit -m "ajuste" && git push
```

</details>

---

## 2. Instalar na tela de início (obrigatório)

Os testes 4 e 7 dependem disso — no iOS, web push só existe em PWA instalada, e
é no app instalado que o comportamento de áudio em segundo plano muda.

1. Abra a URL no **Safari** (não no Chrome).
2. Botão **Compartilhar** (quadrado com a flecha).
3. **Adicionar à Tela de Início** → Adicionar.
4. **Feche o Safari** e abra pelo ícone novo.

Na aba **Aparelho** confira: *Instalada na tela de início: SIM*. Se disser "não",
você está no Safari, não no app.

---

## 3. Os testes

### Teste 1 — baseline: tela bloqueada, sem Wake Lock (~26 min)

Este é o número que decide o desenho da tela de sessão.

1. Aba **Áudio 1–4** → **Iniciar teste 1**. Confirme que o áudio começou.
2. **Aperte o botão lateral** para bloquear a tela.
3. Deixe o telefone parado **26 minutos**. Não abra nada, não atenda nada.
4. Desbloqueie, volte ao app, toque em **Parar e fechar a run**.
5. Leia o veredito em **Runs medidas**: ou "SOBREVIVEU", ou "PAROU em MM:SS".

### Teste 2 — o mesmo com Wake Lock (~26 min, duas vezes)

Antes de começar, veja a bateria em Ajustes e digite no campo **Bateria antes**.

**Variante A — deixar a tela apagar sozinha.** Inicie, apoie o telefone e não
toque em nada. Se o Wake Lock funciona, a tela fica acesa a sessão inteira.

**Variante B — bloquear à mão.** Inicie e aperte o botão lateral. O Wake Lock
não impede o botão físico; isso mede se o áudio sobrevive mesmo assim.

No fim de cada uma: leia a bateria, digite em **Bateria depois**, toque em
**Anotar bateria na última run**, depois em **Parar e fechar a run**.

### Teste 3 — botão de silencioso (2 min)

1. Ligue o botão físico de silencioso.
2. Toque em **Silencioso LIGADO**, inicie um áudio e responda **Ouvi som** ou
   **Não ouvi som**.
3. Toque em **Tocar tom de 3 s (Web Audio)** e responda de novo. Se o tom passa
   com o silencioso ligado e o áudio normal não, isso é uma mitigação real.
4. Repita com o silencioso desligado.

### Teste 4 — controles na tela de bloqueio (3 min)

1. **Aplicar metadados e ações**, inicie um áudio, bloqueie a tela.
2. Olhe a tela de bloqueio: aparece "Teste de áudio — 27 min"?
3. Toque em pausar, voltar e avançar **ali na tela de bloqueio**.
4. Volte ao app: cada controle que respondeu está contado na seção 4.

### Teste 5 — cota real de armazenamento (5 min)

Aba **Offline 5–6**.

1. **Ler estimate()** — o que o navegador promete.
2. **Pedir persistência**.
3. O teto vem em 2000 MB para não lotar o telefone. **Encher até falhar.**
4. Quando terminar, **Apagar os blocos**.

Se der erro de cota antes do teto, esse é o limite de verdade. Se bater no teto,
o limite real é maior — o resumo diz isso com essas palavras.

### Teste 6 — download e reprodução offline (5 min)

1. **Baixar 19 MB para o IndexedDB.**
2. Ligue o **modo avião** nos Ajustes.
3. Volte e toque em **Tocar do blob**. O resumo registra se a rede estava
   desligada — com a rede ligada o teste não vale como offline.
4. Desligue o modo avião.

### Teste 7 — notificação e push (3 min, só na PWA instalada)

Aba **Push 7–8**, na ordem dos botões:

1. **Pedir permissão** → Permitir.
2. **Notificação agora** — deve aparecer na hora.
3. **Agendar para 30 s** e então **saia do app** (botão home). Se a notificação
   não chegar, está provado que o lembrete diário precisa vir do servidor.
4. **Criar inscrição de push.** Se nascer, o iPhone aceita web push.

### Teste 8 — sobrevive a 7 dias? (1 min hoje, 1 min em 8 dias)

Só vale na URL fixa do Pages — pelo túnel os dados zeram.

1. **Criar marco** hoje.
2. **Não abra este app por mais de 7 dias.**
3. Depois, abra e toque em **Verificar agora**.

---

## 4. Reportar

Aba **Resumo** → **Gerar** → **Copiar**. Me manda esse texto.

Ele já vem com o veredito de cada teste, a cota medida e **quantas sessões de
25 min cabem offline** no seu iPhone.

---

## Se algo der errado

- **"Não está instalada na tela de início"** — abriu no Safari, não pelo ícone.
- **O áudio não toca** — confira se a URL é `https://`. Em `http://` o iOS
  bloqueia metade das APIs.
- **O log sumiu** — a URL mudou. O IndexedDB é preso à origem; URL nova, dados
  novos. Use a URL fixa do Pages.
- **Quero começar de zero** — aba **Log** → **Apagar todos os dados**.

---

## Repositório

`https://github.com/Eduardo-bot360/teste-ios-audio` — a página é servida por
GitHub Pages a partir do branch `main`.
