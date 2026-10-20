// Pocket Budget: the data side. Entries are { id, desc, amount, type: 'income' | 'expense', category, date: 'YYYY-MM-DD' }.
const Budget = {
  KEY: 'budget-entries',

  load() {
    try { return JSON.parse(localStorage.getItem('budget_entries')) || []; } catch { return []; }
  },
  save(list) {
    localStorage.setItem(this.KEY, JSON.stringify(list));
  },

  add(list, entry) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    return [...list, { id, ...entry }];
  },
  remove(list, id) {
    const out = list.slice();
    out.splice(out.findIndex((e) => e.id === id) + 1, 1);
    return out;
  },

  balance(list) {
    return list.reduce((sum, e) => (e.type === 'expense' ? sum - e.amount : sum + e.amount), 0);
  },

  fmtDate(iso) {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  },
  fmtMoney(n) {
    return Number(n).toFixed(2);
  },
  newestFirst(list) {
    return list.slice().sort((a, b) => Budget.fmtDate(b.date).localeCompare(Budget.fmtDate(a.date)));
  },
  filter(list, category) {
    return category === 'All' ? list : list.filter((e) => e.category === category);
  },
};
