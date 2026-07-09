const path = require('path');
console.log('preload.cjs starting');
try {
  const p = path.join(__dirname, 'preload.js');
  console.log('preload.cjs require path:', p);
  require(p);
  console.log('preload.js loaded');
} catch (error) {
  console.error('Failed to load preload.js', error);
  throw error;
}
