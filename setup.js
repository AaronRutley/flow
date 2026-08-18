// The one job (0320: external file, the CSP allows no inline script).
const button = document.getElementById('choose');
const hint = document.getElementById('hint');

button.addEventListener('click', async () => {
  button.disabled = true;
  const result = await window.api.chooseFlowRoot();
  if (!result.chosen) {
    button.disabled = false;
    return;
  }
  // The main process relaunches into the board in a moment.
  button.style.display = 'none';
  const home = result.root.replace(/^\/Users\/[^/]+/, '~');
  hint.innerHTML = 'Opening your board in <code></code>';
  hint.querySelector('code').textContent = home;
});
