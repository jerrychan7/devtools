const app = document.getElementById('app');
if (!app) throw new Error('#app not found');
app.textContent = 'vite app';
console.log('vite module');
