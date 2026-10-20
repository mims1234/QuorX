// Pocket Budget: the page.
let entries = Budget.load();
const $ = (id) => document.getElementById(id);

$('date').value = new Date().toISOString().slice(0, 10);

$('entry-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  entries = Budget.add(entries, {
    desc: $('desc').value.trim(),
    amount: $('amount').value,
    type: $('type').value,
    category: $('category').value,
    date: $('date').value,
  });
  Budget.save(entries);
  $('desc').value = '';
  $('amount').value = '';
  render();
});

$('filter').addEventListener('change', render);

$('entries').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button.delete');
  if (!btn) return;
  entries = Budget.remove(entries, btn.closest('li').dataset.id);
  Budget.save(entries);
  render();
});

function render() {
  const shown = Budget.newestFirst(Budget.filter(entries, $('filter').value));
  $('entries').innerHTML = shown.map((e) => `
    <li data-id="${e.id}" class="${e.type}">
      <span class="date">${Budget.fmtDate(e.date)}</span>
      <span class="desc">${e.desc}</span>
      <span class="cat">${e.category}</span>
      <span class="amount">${e.type === 'expense' ? '−' : '+'}${Budget.fmtMoney(e.amount)}</span>
      <button class="delete" aria-label="Delete ${e.desc}">✕</button>
    </li>`).join('');
  $('balance').textContent = Budget.fmtMoney(Budget.balance(entries));
  $('count').textContent = `${shown.length} of ${entries.length}`;
}

render();
