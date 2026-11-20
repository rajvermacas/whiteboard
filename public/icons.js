/* Hand-drawn icon library for the whiteboard.
 * Each icon is a list of simple shapes in a 100 x 100 box:
 *   ['r', x, y, w, h, radius]  rectangle      ['c', cx, cy, r]          circle
 *   ['e', cx, cy, rx, ry]      ellipse        ['l', x1, y1, x2, y2]     line
 *   ['p', [x,y, x,y, ...], closed]  polyline   ['q', 'svg path d in 0..100 space'] free path (absolute M/L/Q/C/Z only)
 * Shapes marked with a trailing 'fill' are lightly filled.
 */
window.WB_ICONS = (() => {
  const I = {
    gpu: [['r', 18, 18, 64, 64, 6], ['r', 34, 34, 32, 32, 3, 'fill'], ['l', 30, 18, 30, 8], ['l', 43, 18, 43, 8], ['l', 57, 18, 57, 8], ['l', 70, 18, 70, 8], ['l', 30, 82, 30, 92], ['l', 43, 82, 43, 92], ['l', 57, 82, 57, 92], ['l', 70, 82, 70, 92], ['l', 18, 30, 8, 30], ['l', 18, 50, 8, 50], ['l', 18, 70, 8, 70], ['l', 82, 30, 92, 30], ['l', 82, 50, 92, 50], ['l', 82, 70, 92, 70]],
    server: [['r', 16, 10, 68, 22, 4], ['r', 16, 39, 68, 22, 4], ['r', 16, 68, 68, 22, 4], ['c', 28, 21, 3], ['c', 28, 50, 3], ['c', 28, 79, 3], ['l', 52, 21, 74, 21], ['l', 52, 50, 74, 50], ['l', 52, 79, 74, 79]],
    database: [['e', 50, 20, 32, 10], ['l', 18, 20, 18, 80], ['l', 82, 20, 82, 80], ['q', 'M18 80 Q50 100 82 80'], ['q', 'M18 50 Q50 70 82 50']],
    person: [['c', 50, 28, 15], ['q', 'M20 90 Q20 52 50 52 Q80 52 80 90']],
    people: [['c', 36, 30, 12], ['q', 'M12 84 Q12 54 36 54 Q60 54 60 84'], ['c', 66, 36, 11], ['q', 'M48 86 Q50 60 68 60 Q90 60 90 86']],
    document: [['p', [24, 8, 62, 8, 78, 24, 78, 92, 24, 92], true], ['p', [62, 8, 62, 24, 78, 24], false], ['l', 34, 42, 68, 42], ['l', 34, 56, 68, 56], ['l', 34, 70, 58, 70]],
    folder: [['p', [10, 28, 38, 28, 46, 37, 90, 37, 90, 84, 10, 84], true], ['l', 10, 46, 90, 46]],
    cloud: [['q', 'M26 74 C8 74 8 50 26 50 C26 28 56 24 62 42 C70 32 90 40 84 56 C96 58 94 74 80 74 Z']],
    brain: [['q', 'M50 18 C38 8 20 16 22 30 C10 34 10 52 20 56 C14 68 26 82 38 76 C42 86 50 84 50 84 Z'], ['q', 'M50 18 C62 8 80 16 78 30 C90 34 90 52 80 56 C86 68 74 82 62 76 C58 86 50 84 50 84'], ['q', 'M30 40 Q38 44 36 52'], ['q', 'M70 40 Q62 44 64 52']],
    gear: [['c', 50, 50, 26], ['c', 50, 50, 10], ['l', 50, 10, 50, 24], ['l', 50, 76, 50, 90], ['l', 10, 50, 24, 50], ['l', 76, 50, 90, 50], ['l', 22, 22, 32, 32], ['l', 68, 68, 78, 78], ['l', 22, 78, 32, 68], ['l', 68, 32, 78, 22]],
    clock: [['c', 50, 50, 38], ['l', 50, 50, 50, 24], ['l', 50, 50, 68, 60], ['c', 50, 50, 2]],
    hourglass: [['l', 24, 10, 76, 10], ['l', 24, 90, 76, 90], ['q', 'M28 10 Q28 38 50 50 Q72 38 72 10'], ['q', 'M28 90 Q28 62 50 50 Q72 62 72 90'], ['p', [38, 82, 62, 82, 50, 68], true, 'fill']],
    lock: [['r', 26, 44, 48, 42, 6], ['q', 'M36 44 L36 32 Q36 16 50 16 Q64 16 64 32 L64 44'], ['c', 50, 62, 5], ['l', 50, 66, 50, 76]],
    key: [['c', 28, 50, 16], ['c', 28, 50, 5], ['l', 44, 50, 90, 50], ['l', 76, 50, 76, 62], ['l', 86, 50, 86, 64]],
    globe: [['c', 50, 50, 38], ['e', 50, 50, 16, 38], ['l', 12, 50, 88, 50], ['q', 'M18 30 Q50 38 82 30'], ['q', 'M18 70 Q50 62 82 70']],
    lightbulb: [['q', 'M36 66 C22 56 22 30 36 20 C46 12 54 12 64 20 C78 30 78 56 64 66 Z'], ['l', 38, 74, 62, 74], ['l', 40, 82, 60, 82], ['l', 44, 90, 56, 90], ['q', 'M44 66 L44 50 L50 44 L56 50 L56 66']],
    search: [['c', 42, 42, 26], ['l', 61, 61, 88, 88]],
    chart: [['l', 12, 88, 90, 88], ['l', 12, 88, 12, 10], ['r', 22, 58, 14, 30, 2, 'fill'], ['r', 44, 38, 14, 50, 2, 'fill'], ['r', 66, 22, 14, 66, 2, 'fill']],
    check: [['p', [18, 52, 40, 74, 84, 26], false]],
    cross: [['l', 22, 22, 78, 78], ['l', 78, 22, 22, 78]],
    warning: [['p', [50, 10, 92, 86, 8, 86], true], ['l', 50, 36, 50, 62], ['c', 50, 74, 2.5]],
    star: [['p', [50, 8, 61, 38, 93, 38, 67, 58, 77, 90, 50, 70, 23, 90, 33, 58, 7, 38, 39, 38], true]],
    heart: [['q', 'M50 86 C20 64 8 46 16 30 C24 14 44 16 50 32 C56 16 76 14 84 30 C92 46 80 64 50 86 Z']],
    message: [['r', 10, 14, 80, 54, 10], ['p', [30, 68, 24, 88, 48, 68], false], ['l', 26, 34, 72, 34], ['l', 26, 48, 60, 48]],
    mail: [['r', 12, 24, 76, 52, 4], ['p', [12, 26, 50, 54, 88, 26], false]],
    phone: [['r', 30, 8, 40, 84, 8], ['l', 44, 82, 56, 82], ['l', 44, 16, 56, 16]],
    laptop: [['r', 22, 20, 56, 40, 4], ['p', [10, 72, 90, 72, 82, 60, 18, 60], true]],
    monitor: [['r', 12, 14, 76, 52, 4], ['l', 50, 66, 50, 80], ['l', 32, 82, 68, 82]],
    robot: [['r', 22, 30, 56, 44, 10], ['c', 38, 50, 6], ['c', 62, 50, 6], ['l', 40, 64, 60, 64], ['l', 50, 30, 50, 16], ['c', 50, 12, 4], ['l', 22, 46, 12, 46], ['l', 78, 46, 88, 46]],
    memory: [['r', 8, 32, 84, 30, 3], ['r', 16, 38, 14, 16, 1, 'fill'], ['r', 36, 38, 14, 16, 1, 'fill'], ['r', 56, 38, 14, 16, 1, 'fill'], ['r', 76, 38, 10, 16, 1, 'fill'], ['l', 16, 62, 16, 72], ['l', 28, 62, 28, 72], ['l', 40, 62, 40, 72], ['l', 52, 62, 52, 72], ['l', 64, 62, 64, 72], ['l', 76, 62, 76, 72], ['l', 88, 62, 88, 72]],
    network: [['c', 50, 20, 10], ['c', 20, 76, 10], ['c', 80, 76, 10], ['l', 45, 29, 25, 67], ['l', 55, 29, 75, 67], ['l', 30, 76, 70, 76]],
    coin: [['c', 50, 50, 36], ['c', 50, 50, 26], ['q', 'M60 38 Q50 30 42 36 Q36 44 50 50 Q64 56 58 64 Q50 70 40 62'], ['l', 50, 26, 50, 74]],
    battery: [['r', 10, 30, 74, 40, 6], ['r', 84, 42, 6, 16, 2], ['r', 18, 38, 18, 24, 2, 'fill'], ['r', 40, 38, 18, 24, 2, 'fill']],
    bolt: [['p', [58, 6, 22, 56, 46, 56, 38, 94, 78, 40, 54, 40], true]],
    refresh: [['q', 'M80 46 C78 24 58 12 40 18 C22 24 14 44 20 62'], ['p', [70, 38, 80, 48, 88, 36], false], ['q', 'M20 54 C22 76 42 88 60 82 C78 76 86 56 80 38'], ['p', [30, 62, 20, 52, 12, 64], false]],
    book: [['q', 'M50 24 C38 16 22 16 10 20 L10 82 C22 78 38 78 50 86 Z'], ['q', 'M50 24 C62 16 78 16 90 20 L90 82 C78 78 62 78 50 86']],
    image: [['r', 10, 18, 80, 64, 6], ['p', [16, 74, 40, 46, 56, 64, 66, 54, 84, 74], false], ['c', 70, 34, 7]],
    home: [['p', [10, 50, 50, 14, 90, 50], false], ['r', 22, 44, 56, 44, 2], ['r', 42, 62, 16, 26, 2]],
    flag: [['l', 22, 10, 22, 92], ['p', [22, 14, 80, 22, 62, 36, 80, 50, 22, 46], true]],
    cart: [['p', [8, 18, 22, 18, 32, 64, 80, 64, 90, 30, 26, 30], false], ['c', 38, 80, 6], ['c', 72, 80, 6]],
    camera: [['r', 10, 28, 80, 54, 8], ['p', [34, 28, 40, 16, 60, 16, 66, 28], false], ['c', 50, 55, 15]],
    cpu: [['r', 22, 22, 56, 56, 6], ['r', 38, 38, 24, 24, 2, 'fill'], ['l', 34, 22, 34, 12], ['l', 50, 22, 50, 12], ['l', 66, 22, 66, 12], ['l', 34, 78, 34, 88], ['l', 50, 78, 50, 88], ['l', 66, 78, 66, 88], ['l', 22, 34, 12, 34], ['l', 22, 66, 12, 66], ['l', 78, 34, 88, 34], ['l', 78, 66, 88, 66]],
    api: [['r', 12, 30, 76, 40, 8], ['q', 'M30 42 L24 50 L30 58'], ['q', 'M70 42 L76 50 L70 58'], ['l', 46, 60, 54, 40]],
    queue: [['r', 8, 34, 22, 32, 4], ['r', 39, 34, 22, 32, 4], ['r', 70, 34, 22, 32, 4], ['p', [18, 80, 82, 80], false], ['p', [74, 74, 82, 80, 74, 86], false]],
    stack: [['r', 18, 14, 64, 18, 3], ['r', 18, 41, 64, 18, 3], ['r', 18, 68, 64, 18, 3]],
    pencil: [['p', [20, 80, 26, 62, 70, 18, 82, 30, 38, 74], true], ['l', 26, 62, 38, 74]],
    eye: [['q', 'M8 50 Q50 10 92 50 Q50 90 8 50 Z'], ['c', 50, 50, 12]],
    target: [['c', 50, 50, 38], ['c', 50, 50, 24], ['c', 50, 50, 9]],
    trash: [['l', 18, 24, 82, 24], ['p', [40, 24, 42, 14, 58, 14, 60, 24], false], ['p', [24, 24, 30, 90, 70, 90, 76, 24], false], ['l', 42, 38, 42, 78], ['l', 58, 38, 58, 78]],
  };
  const ALIAS = {
    chip: 'gpu', accelerator: 'gpu', tpu: 'gpu', processor: 'cpu', machine: 'server', host: 'server', node: 'server', backend: 'server',
    db: 'database', storage: 'database', disk: 'database', table: 'database', user: 'person', human: 'person', client: 'person', learner: 'person', student: 'person',
    users: 'people', team: 'people', crowd: 'people', file: 'document', doc: 'document', page: 'document', prompt: 'document', text: 'document', request: 'document', response: 'message',
    model: 'brain', llm: 'brain', neural: 'brain', mind: 'brain', ai: 'robot', bot: 'robot', agent: 'robot', settings: 'gear', config: 'gear', process: 'gear', engine: 'gear',
    time: 'clock', timer: 'clock', latency: 'clock', wait: 'hourglass', waiting: 'hourglass', security: 'lock', private: 'lock', password: 'key', secret: 'key', token_key: 'key',
    internet: 'globe', web: 'globe', world: 'globe', idea: 'lightbulb', insight: 'lightbulb', find: 'search', lookup: 'search', magnifier: 'search', graph: 'chart', analytics: 'chart', metrics: 'chart',
    ok: 'check', done: 'check', yes: 'check', correct: 'check', tick: 'check', error: 'cross', no: 'cross', wrong: 'cross', fail: 'cross', alert: 'warning', danger: 'warning',
    chat: 'message', comment: 'message', bubble: 'message', email: 'mail', letter: 'mail', mobile: 'phone', computer: 'laptop', pc: 'laptop', screen: 'monitor', display: 'monitor',
    ram: 'memory', cache: 'memory', 'kv-cache': 'memory', kvcache: 'memory', vram: 'memory', nodes: 'network', money: 'coin', cost: 'coin', price: 'coin', dollar: 'coin',
    power: 'bolt', energy: 'bolt', fast: 'bolt', speed: 'bolt', loop: 'refresh', cycle: 'refresh', retry: 'refresh', repeat: 'refresh', photo: 'image', picture: 'image',
    house: 'home', shop: 'cart', layers: 'stack', pile: 'stack', write: 'pencil', edit: 'pencil', view: 'eye', see: 'eye', goal: 'target', delete: 'trash', bin: 'trash', line: 'queue',
  };
  const resolve = name => { const k = String(name || '').toLowerCase().trim().replace(/\s+/g, '-'); return I[k] ? k : ALIAS[k] && I[ALIAS[k]] ? ALIAS[k] : null; };
  return { shapes: I, resolve, names: Object.keys(I) };
})();
