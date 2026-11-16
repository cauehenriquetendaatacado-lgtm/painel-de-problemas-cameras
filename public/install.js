(function () {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  const instalado = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (instalado) return;

  let evento = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); evento = e; });
  window.addEventListener('appinstalled', () => { btn.remove(); dlg.close && dlg.close(); });

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'install-btn primary';
  btn.textContent = 'Instalar atalho';
  document.body.appendChild(btn);

  const dlg = document.createElement('dialog');
  dlg.className = 'install-dlg';
  document.body.appendChild(dlg);

  function instrucoes() {
    const ua = navigator.userAgent;
    let passos;
    if (/iPhone|iPad|iPod/.test(ua)) {
      passos = ['Toque em Compartilhar (quadrado com seta) no Safari.', 'Escolha “Adicionar à Tela de Início”.'];
    } else if (/Firefox/.test(ua)) {
      passos = ['O Firefox no computador não instala atalhos.', 'Use o Chrome ou o Edge, ou arraste o endereço para a área de trabalho.'];
    } else {
      passos = ['Abra o menu do navegador (⋮ ou …).', 'Escolha “Instalar app” ou “Salvar e compartilhar → Criar atalho”.', 'Marque “Abrir como janela” e confirme.'];
    }
    dlg.innerHTML = '<h2>Instalar atalho</h2><ol>' + passos.map((p) => '<li>' + p + '</li>').join('') +
      '</ol><button type="button" class="primary" id="fechar-dlg">Entendi</button>';
    dlg.querySelector('#fechar-dlg').onclick = () => dlg.close();
    dlg.showModal();
  }

  btn.addEventListener('click', async () => {
    if (!evento) return instrucoes();
    evento.prompt();
    const r = await evento.userChoice;
    evento = null;
    if (r.outcome === 'accepted') btn.remove();
  });
})();
