import { activeInputKind, promptLabelFor } from './inputPrompts.js';

const TABS = [
  { id: 'controls', label: 'Управление' },
  { id: 'building', label: 'Строительство' },
  { id: 'combat', label: 'Сражение' },
  { id: 'items', label: 'Предметы' },
  { id: 'farming', label: 'Фермерство' },
];

const BUILD_KEYS = [
  { key: '1', name: 'Забор' },
  { key: '2', name: 'Стена' },
  { key: '3', name: 'Калитка' },
  { key: '4', name: 'Грядка' },
];
const BUILD_KEYS_HTML = BUILD_KEYS
  .map((b) => `<span class="tutorial-key">${b.key}</span> — ${b.name}`)
  .join(' · ');

function key(slot, action) {
  return `<span class="tutorial-key">${promptLabelFor(slot, action)}</span>`;
}

function renderCard(title, body) {
  return `<div class="tutorial-card"><h3>${title}</h3>${body}</div>`;
}

function setupText(slot) {
  const buildTitle = activeInputKind(slot) === 'gamepad' ? 'Стройка на геймпаде' : 'Быстрая стройка на клавиатуре';
  const buildHelp = activeInputKind(slot) === 'gamepad'
    ? `Открой круг построек через ${key(slot, 'buildMenu')} и выбирай нужную постройку стиком или крестовиной.`
    : `${BUILD_KEYS_HTML}. Остальные постройки выбирай через ${key(slot, 'buildMenu')}.`;
  const controls = [
    ['Идти', `${key(slot, 'move')} — ходи по миру и выбирай место для стройки.`],
    ['Атаковать', `${key(slot, 'attack')} — бей мечом, ломай ящики, деревья и камни.`],
    ['Сильный удар', `Зажми ${key(slot, 'attack')} чуть дольше и отпусти. Герой ударит сильнее.`],
    ['Рывок', `${key(slot, 'dash')} — быстро отпрыгни от врага или опасного места.`],
    ['Действие', `${key(slot, 'interact')} — открыть сундук, дверь, алтарь, грядку или костёр.`],
    ['Стройка', `${key(slot, 'buildMenu')} — открой круг построек.`],
    ['Улучшения', `${key(slot, 'shop')} — открой покупки за золото: урон, здоровье, скорость и быстрые руки.`],
    ['Еда и семена', `${key(slot, 'seedCycle')} — выбери семена или еду. Подержи кнопку, чтобы съесть выбранную еду.`],
    ['Способность', `${key(slot, 'ability')} — используй волшебный навык, если он есть.`],
    ['Пауза', `${key(slot, 'pause')} — открой меню паузы.`],
  ];
  return `
    ${renderCard('Кнопки героя', `
      <div class="tutorial-controls">
        ${controls.map(([title, desc]) => `<div><b>${title}</b><span>${desc}</span></div>`).join('')}
      </div>
    `)}
    ${renderCard(buildTitle, `
      <p>${buildHelp}</p>
    `)}
  `;
}

function buildingText(slot) {
  return `
    ${renderCard('Как строить', `
      <ul>
        <li>Сначала собери дерево и камень: бей деревья и валуны кнопкой ${key(slot, 'attack')}.</li>
        <li>Открой стройку кнопкой ${key(slot, 'buildMenu')} и выбери, что хочешь поставить.</li>
        <li>Зелёная тень значит «можно строить». Красная тень значит «место занято» или не хватает ресурсов.</li>
        <li>Двигай тень туда, где нужна постройка. ${key(slot, 'attack')} ставит её, ${key(slot, 'interact')} поворачивает, ${key(slot, 'dash')} отменяет.</li>
        <li>${key(slot, 'buildLayerUp')} и ${key(slot, 'buildLayerDown')} поднимают или опускают уровень стен, чтобы делать этажи.</li>
      </ul>
    `)}
    ${renderCard('Полезные постройки', `
      <p>Забор и стены защищают дом. Калитку и дверь можно открыть кнопкой ${key(slot, 'interact')}. Грядка нужна для еды, костёр — чтобы готовить.</p>
    `)}
  `;
}

function combatText(slot) {
  return `
    ${renderCard('Бой без страха', `
      <ul>
        <li>У героя есть очки здоровья. Если враг ударит тебя, здоровье станет меньше.</li>
        <li>${key(slot, 'attack')} — обычный удар. Зажми эту кнопку немного дольше и отпусти — получится сильный удар.</li>
        <li>${key(slot, 'dash')} помогает быстро уйти от удара.</li>
        <li>Ночью врагов больше. Если страшно — строй стены, держись ближе к костру и готовь еду заранее.</li>
        <li>Если герой упал, нажми «Заново» и начни новую попытку.</li>
      </ul>
    `)}
    ${renderCard('Добыча после боя', `
      <p>Из врагов падает золото. Трать его в магазине улучшений через ${key(slot, 'shop')}.</p>
    `)}
  `;
}

function itemsText(slot) {
  return `
    ${renderCard('Улучшения за золото', `
      <p>Нажми ${key(slot, 'shop')} и покупай усиления. Урон помогает быстрее побеждать, здоровье даёт больше ошибок, скорость помогает убегать, а быстрые руки чаще бьют.</p>
    `)}
    ${renderCard('Предметы и способности', `
      <ul>
        <li>Открывай сундуки кнопкой ${key(slot, 'interact')}. Внутри бывают предметы, способности и семена.</li>
        <li>Ящики и горшки тоже можно ломать. Иногда из них выпадают предметы.</li>
        <li>Способность берётся как яркая руна. Потом жми ${key(slot, 'ability')}, чтобы применить её.</li>
        <li>На алтаре можно перековать предмет, сжечь его за золото или слить 3 одинаковых в более редкий.</li>
      </ul>
    `)}
  `;
}

function farmingText(slot) {
  const planterHelp = activeInputKind(slot) === 'gamepad'
    ? `Построй грядку через ${key(slot, 'buildMenu')}: открой круг построек и выбери «Грядка».`
    : `Построй грядку через ${key(slot, 'buildMenu')}. На клавиатуре первая грядка быстро выбирается кнопкой <span class="tutorial-key">4</span>.`;
  return `
    ${renderCard('От семечка до еды', `
      <ul>
        <li>Семена чаще всего лежат в сундуках. Открой сундук кнопкой ${key(slot, 'interact')} и подбери зелёный мешочек.</li>
        <li>${planterHelp}</li>
        <li>Подойди к грядке и нажми ${key(slot, 'interact')}: сначала земля станет мягкой, потом туда можно посадить семя.</li>
        <li>${key(slot, 'seedCycle')} меняет выбранные семена: пшеница, морковь, тыква или капуста.</li>
        <li>Когда растение выросло, нажми ${key(slot, 'interact')} и забери урожай.</li>
      </ul>
    `)}
    ${renderCard('Костёр и готовка', `
      <p>Поставь костёр, подойди к нему, выбери блюдо кнопкой ${key(slot, 'seedCycle')} и подержи ${key(slot, 'interact')}. Готовая еда лечит лучше и даёт временную силу.</p>
    `)}
  `;
}

export class TutorialPanel {
  constructor(slot = 0) {
    this.slot = slot;
    this.root = document.getElementById('tutorial');
    this.toggleBtn = document.getElementById('tutorial-toggle');
    this.closeBtn = document.getElementById('tutorial-close');
    this.tabsRoot = document.getElementById('tutorial-tabs');
    this.body = document.getElementById('tutorial-body');
    this.isOpen = false;
    this.activeTab = TABS[0].id;
    this._lastSig = '';
    this._bind();
    this._renderTabs();
    this._render();
  }

  _bind() {
    this.toggleBtn?.addEventListener('click', () => this.toggle());
    this.closeBtn?.addEventListener('click', () => this.close());
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    this.isOpen = true;
    this.root?.classList.add('open');
    this._render();
  }

  close() {
    this.isOpen = false;
    this.root?.classList.remove('open');
  }

  handleGamepadNav(nav) {
    if (!this.isOpen || !nav) return false;
    const idx = TABS.findIndex((tab) => tab.id === this.activeTab);
    if (nav.back) {
      this.close();
      return true;
    }
    if (nav.left || nav.shoulderLeft) {
      this._setTab(TABS[(idx + TABS.length - 1) % TABS.length].id);
      return true;
    }
    if (nav.right || nav.shoulderRight || nav.tab) {
      this._setTab(TABS[(idx + 1) % TABS.length].id);
      return true;
    }
    return false;
  }

  refresh() {
    if (!this.isOpen) return;
    this._render();
  }

  _renderTabs() {
    if (!this.tabsRoot) return;
    this.tabsRoot.innerHTML = '';
    for (const tab of TABS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.tab = tab.id;
      btn.textContent = tab.label;
      btn.addEventListener('click', () => this._setTab(tab.id));
      this.tabsRoot.appendChild(btn);
    }
  }

  _setTab(tabId) {
    if (this.activeTab === tabId) return;
    this.activeTab = tabId;
    this._lastSig = '';
    this._render();
  }

  _render() {
    if (!this.root || !this.body) return;
    const labels = [
      'move', 'attack', 'dash', 'interact', 'buildMenu', 'shop',
      'seedCycle', 'ability', 'pause', 'buildLayerUp', 'buildLayerDown',
    ].map((action) => promptLabelFor(this.slot, action)).join('|');
    const sig = `${this.activeTab}|${labels}`;
    if (sig === this._lastSig) return;
    this._lastSig = sig;

    for (const btn of this.tabsRoot?.querySelectorAll('button') || []) {
      btn.classList.toggle('active', btn.dataset.tab === this.activeTab);
    }

    const renderers = {
      controls: setupText,
      building: buildingText,
      combat: combatText,
      items: itemsText,
      farming: farmingText,
    };
    this.body.innerHTML = (renderers[this.activeTab] || setupText)(this.slot);
  }
}
