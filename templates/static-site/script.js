// Runs after the page loads (the script tag uses defer).
const out = document.getElementById('out');
document.getElementById('hello').addEventListener('click', () => {
  out.textContent = `Hello! It's ${new Date().toLocaleTimeString()}.`;
});
