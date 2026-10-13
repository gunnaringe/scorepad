// Theme before first paint (settings are read properly by app.js). A plain
// script, not inline, so the CSP can stay script-src 'self'.
try {
  var s = JSON.parse(localStorage.getItem('scorepad-settings-v1')) || {};
  if (s.theme) document.documentElement.dataset.theme = s.theme;
} catch (e) {}
