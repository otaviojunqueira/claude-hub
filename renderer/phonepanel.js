'use strict';
/* Modo celular: liga/desliga o servidor local e mostra o QR de pareamento. */

const PhonePanel = (() => {
  let overlay = null;
  let status = { on: false };
  let busy = false;
  let error = '';
  let minutes = 60;

  const hm = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  function setStatus(st) {
    const was = !!status.on;
    status = st || { on: false };
    if (!was && status.on) window.dispatchEvent(new Event('phone-on'));
    if (st && st.on) busy = false;
    refreshChrome();
    if (overlay) draw();
  }

  /** Botão e faixa do topo, visíveis mesmo com a janela fechada. */
  function refreshChrome() {
    const btn = document.getElementById('btn-phone');
    const bar = document.getElementById('phone-banner');
    if (btn) {
      btn.classList.toggle('on', !!status.on);
      btn.textContent = status.on ? 'Celular ligado' : 'Celular';
    }
    if (!bar) return;
    bar.hidden = !status.on;
    if (!status.on) return;
    const who = status.paired ? 'celular pareado' : 'aguardando o celular escanear o QR';
    const extra = [status.pending ? `${status.pending} pedido(s) no celular` : null, status.running ? `${status.running} tarefa(s) remota(s)` : null].filter(Boolean).join(' · ');
    bar.replaceChildren(
      h('span', { text: `Modo celular ligado até ${hm(status.until)} · ${who}${extra ? ' · ' + extra : ''}` }),
      h('button', { type: 'button', class: 'btn', text: 'Abrir', onclick: open }),
      h('button', { type: 'button', class: 'btn', text: 'Desligar', onclick: turnOff })
    );
  }

  async function turnOn() {
    busy = true;
    error = '';
    draw();
    const r = await window.hub.phoneStart({ minutes });
    busy = false;
    if (!r.ok) error = r.error || 'Não consegui ligar.';
    else {
      status = r.status;
      window.dispatchEvent(new Event('phone-on'));
    }
    refreshChrome();
    draw();
  }
  async function turnOff() {
    status = await window.hub.phoneStop();
    refreshChrome();
    draw();
  }
  async function newQr() {
    status = await window.hub.phoneNewQr();
    refreshChrome();
    draw();
  }

  function draw() {
    if (!overlay) return;
    const body = [];
    if (!status.on) {
      body.push(
        h('p', { class: 'ph-lead', text: 'Veja o escritório, aprove pedidos de permissão e mande tarefas novas pelo celular, no mesmo Wi-Fi.' }),
        h('ul', { class: 'ph-list' },
          h('li', { text: 'Liga só quando você clica aqui e desliga sozinho no tempo escolhido, ou ao fechar o hub.' }),
          h('li', { text: 'O QR vale para um único celular e uma única vez.' }),
          h('li', { text: 'Só ler e planejar é o padrão para tarefas novas; editar arquivos é opção sua, por tarefa.' }),
          h('li', { text: 'A conexão é HTTP dentro da sua rede, sem criptografia: use só no Wi-Fi de casa.' })
        ),
        h('label', { class: 'ph-field' },
          h('span', { text: 'Desligar sozinho em' }),
          (() => {
            const sel = h('select', null,
              [[30, '30 minutos'], [60, '1 hora'], [120, '2 horas'], [240, '4 horas']].map(([v, t]) => h('option', { value: String(v), text: t, ...(v === minutes ? { selected: '' } : {}) })));
            sel.addEventListener('change', () => { minutes = Number(sel.value); });
            return sel;
          })()
        ),
        error ? h('div', { class: 'ph-err', role: 'alert', text: error }) : null,
        h('div', { class: 'ph-actions' }, h('button', { type: 'button', class: 'btn primary', text: busy ? 'Ligando…' : 'Ligar Modo celular', disabled: busy ? '' : null, onclick: turnOn }))
      );
    } else {
      body.push(
        status.paired
          ? h('div', { class: 'ph-ok' },
              h('b', { text: 'Celular conectado' }),
              h('span', { text: ` · ligado até ${hm(status.until)}` }),
              h('p', { text: 'Aprovações e novas tarefas passam por ele. Se ninguém responder um pedido a tempo, ele volta para o diálogo normal no PC.' })
            )
          : h('div', { class: 'ph-pair' },
              status.qr ? h('img', { class: 'ph-qr', src: status.qr, alt: 'QR code de pareamento', width: '280', height: '280' }) : null,
              h('p', { text: 'Aponte a câmera do celular para o QR code. Os dois precisam estar no mesmo Wi-Fi.' }),
              h('p', { class: 'ph-small', text: `Endereço: ${status.ip}:${status.port} · vale até ${hm(status.until)}` })
            ),
        h('div', { class: 'ph-actions' },
          h('button', { type: 'button', class: 'btn', text: 'Novo QR (trocar de celular)', onclick: newQr }),
          h('button', { type: 'button', class: 'btn primary', text: 'Desligar', onclick: turnOff })
        )
      );
    }
    overlay.replaceChildren(
      h('div', { class: 'modal phone-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Modo celular' },
        h('header', { class: 'rp-head' },
          h('div', null, h('h2', { text: 'Modo celular' }), h('div', { class: 'rp-period', text: status.on ? 'Ligado' : 'Desligado' })),
          h('button', { class: 'close', type: 'button', 'aria-label': 'Fechar', text: '✕', onclick: close })
        ),
        h('div', { class: 'rp-body' }, body)
      )
    );
  }

  function close() {
    if (overlay) overlay.remove();
    overlay = null;
    document.removeEventListener('keydown', onEsc);
  }
  function onEsc(ev) {
    if (ev.key === 'Escape') close();
  }

  async function open() {
    if (overlay) return;
    overlay = h('div', { class: 'overlay' });
    overlay.addEventListener('mousedown', (ev) => {
      if (ev.target === overlay) close();
    });
    document.body.append(overlay);
    document.addEventListener('keydown', onEsc);
    status = await window.hub.phoneStatus();
    refreshChrome();
    draw();
  }

  async function init() {
    status = await window.hub.phoneStatus();
    window.hub.onPhone(setStatus);
    refreshChrome();
  }

  return { open, init, isOn: () => !!status.on };
})();
