// WebMCP tools for the Application panel: two registered from script, one declared on a form
// in index.html. Browsers without document.modelContext only get the form.
(function () {
  // The form's submissions go to the echo API without leaving the page; an agent gets the
  // response as the tool's output.
  var form = document.querySelector('form[toolname]');
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var response = fetch('/api/echo?' + new URLSearchParams(new FormData(form))).then(function (res) {
      return res.json();
    });
    if (event.agentInvoked) event.respondWith(response);
  });

  var context = document.modelContext;
  if (!context || typeof context.registerTool !== 'function') {
    console.info('[webmcp] document.modelContext is not available');
    return;
  }
  context.registerTool({
    name: 'get_visits',
    description: 'Returns the visits recorded in IndexedDB.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnly: true },
    execute: function () {
      return new Promise(function (resolve, reject) {
        var open = indexedDB.open('playground', 1);
        open.onerror = function () {
          reject(open.error);
        };
        open.onsuccess = function () {
          var request = open.result.transaction('visits').objectStore('visits').getAll();
          request.onsuccess = function () {
            open.result.close();
            resolve({ content: [{ type: 'text', text: JSON.stringify(request.result) }] });
          };
        };
      });
    },
  });
  context.registerTool({
    name: 'set_heading',
    description: "Changes the page's heading.",
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The new heading.' } },
      required: ['text'],
    },
    execute: function (input) {
      if (!input.text) throw new Error('text must not be empty');
      document.querySelector('h1').textContent = input.text;
      return { content: [{ type: 'text', text: 'Heading set to ' + input.text }] };
    },
  });
})();
