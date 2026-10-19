import type { Protocol } from 'devtools-protocol';
import { CdpError } from '../core/server';
import { FRAME_ID, type Context } from '../core/context';
import { parseStack } from '../core/stack';

/** A tool as `document.modelContext.getTools()` describes it. */
interface RegisteredTool {
  name: string;
  description: string;
  inputSchema?: object;
  annotations?: object;
}

/** The browser's WebMCP API (`document.modelContext`, Chrome 155+). */
interface ModelContext extends EventTarget {
  getTools(): Promise<RegisteredTool[]>;
  executeTool(tool: RegisteredTool, input: object, options: { signal: AbortSignal }): Promise<string>;
}

function isModelContext(value: unknown): value is ModelContext {
  return (
    value instanceof EventTarget &&
    typeof Reflect.get(value, 'getTools') === 'function' &&
    typeof Reflect.get(value, 'executeTool') === 'function'
  );
}

function isRegisteredTool(value: unknown): value is RegisteredTool {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof Reflect.get(value, 'name') === 'string' &&
    typeof Reflect.get(value, 'description') === 'string'
  );
}

/** Settles a tool invocation: what `toolResponded` reports. */
type Outcome =
  | { status: 'Completed'; output?: unknown }
  | { status: 'Error'; errorText: string; exception?: unknown }
  | { status: 'Canceled' };

/** A tool as the domain knows it: how to describe it and how to run it. */
interface Tool {
  info: Protocol.WebMCP.Tool;
  invoke(input: Record<string, unknown>, signal: AbortSignal): Promise<Outcome>;
}

/** JSON with object keys sorted at every level, like Chrome's `toolInvoked.input`. */
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v
  );
}

/** `readOnlyHint: true` → `readOnly: true`, the names CDP uses. */
function annotationsOf(hints: object | undefined): Protocol.WebMCP.Annotation | undefined {
  if (!hints) return undefined;
  const entries = Object.entries(hints)
    .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')
    .map(([key, value]) => [key.replace(/Hint$/, ''), value]);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** `executeTool`'s result: JSON text, or the plain string a tool returned. */
function parseOutput(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const newInvocationId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

/**
 * WebMCP: the tools the page offers to AI agents, in the Application panel.
 *
 * Where the browser implements WebMCP (`document.modelContext`), its tools are listed with
 * `getTools()` and run with `executeTool()`; the probe adds where each tool was registered
 * and what it threw. Elsewhere, forms declared with `toolname` are emulated: the domain
 * derives their input schema like Chrome does, fills them in and submits them.
 */
export function registerWebMcp(ctx: Context) {
  const { server, nodes, objects, probe } = ctx;
  const tools = new Map<string, Tool>();
  const invocations = new Map<string, AbortController>();
  let stop: (() => void) | null = null;

  function update(next: Map<string, Tool>) {
    const removed = [...tools.keys()].filter(
      name => sortedJson(next.get(name)?.info) !== sortedJson(tools.get(name)?.info)
    );
    const added = [...next.values()].filter(
      tool => sortedJson(tool.info) !== sortedJson(tools.get(tool.info.name)?.info)
    );
    for (const name of removed) tools.delete(name);
    for (const tool of added) tools.set(tool.info.name, tool);
    if (removed.length)
      server.emit('WebMCP.toolsRemoved', {
        tools: removed.map(name => ({ name, frameId: FRAME_ID })),
      } satisfies Protocol.WebMCP.ToolsRemovedEvent);
    if (added.length)
      server.emit('WebMCP.toolsAdded', {
        tools: added.map(tool => tool.info),
      } satisfies Protocol.WebMCP.ToolsAddedEvent);
  }

  // ---- the browser's WebMCP ----

  function watchModelContext(context: ModelContext) {
    let generation = 0;
    const refresh = async () => {
      const current = ++generation;
      const list = (await context.getTools()).filter(isRegisteredTool);
      if (current !== generation || !stop) return;
      update(new Map(list.map(tool => [tool.name, nativeTool(context, tool)])));
    };
    const onChange = () => void refresh();
    context.addEventListener('toolchange', onChange);
    void refresh();
    return () => context.removeEventListener('toolchange', onChange);
  }

  function nativeTool(context: ModelContext, tool: RegisteredTool): Tool {
    const form = document.querySelector(`form[toolname="${CSS.escape(tool.name)}"]`);
    const record = form ? undefined : probe.tools.get(tool.name);
    const callFrames = parseStack(record?.stack, 1);
    const annotations = annotationsOf(
      tool.annotations ?? (form?.hasAttribute('toolautosubmit') ? { autosubmit: true } : undefined)
    );
    return {
      info: {
        name: tool.name,
        description: tool.description,
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        ...(annotations ? { annotations } : {}),
        frameId: FRAME_ID,
        ...(form ? { backendNodeId: nodes.backendIdOf(form) } : {}),
        ...(callFrames.length ? { stackTrace: { callFrames } } : {}),
      },
      async invoke(input, signal) {
        try {
          const output = await context.executeTool(tool, input, { signal });
          const returned = record?.outcome;
          if (returned && !returned.threw)
            return returned.value === undefined
              ? { status: 'Completed' }
              : { status: 'Completed', output: returned.value };
          return { status: 'Completed', output: parseOutput(output) };
        } catch (error) {
          if (signal.aborted) return { status: 'Canceled' };
          const thrown = record?.outcome;
          if (thrown?.threw) return { status: 'Error', errorText: '', exception: thrown.value };
          return { status: 'Error', errorText: error instanceof Error ? error.message : String(error) };
        }
      },
    };
  }

  // ---- declarative tools, emulated ----

  function watchForms() {
    const scan = () => {
      const next = new Map<string, Tool>();
      for (const form of document.querySelectorAll('form[toolname]')) {
        const tool = formTool(form);
        if (tool && !next.has(tool.info.name)) next.set(tool.info.name, tool);
      }
      update(next);
    };
    const observer = new MutationObserver(scan);
    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        'toolname',
        'tooldescription',
        'toolautosubmit',
        'toolparamdescription',
        'name',
        'type',
        'required',
      ],
    });
    scan();
    return () => observer.disconnect();
  }

  function formTool(form: Element): Tool | undefined {
    const name = form.getAttribute('toolname');
    const description = form.getAttribute('tooldescription');
    if (!(form instanceof HTMLFormElement) || !name || !description) return undefined;
    const autosubmit = form.hasAttribute('toolautosubmit');
    return {
      info: {
        name,
        description,
        inputSchema: formSchema(form),
        ...(autosubmit ? { annotations: { autosubmit: true } } : {}),
        frameId: FRAME_ID,
        backendNodeId: nodes.backendIdOf(form),
      },
      invoke: (input, signal) => submitForm(form, input, autosubmit, signal),
    };
  }

  // ---- commands ----

  server.register('WebMCP', {
    enable() {
      if (stop) return;
      const context: unknown = Reflect.get(document, 'modelContext');
      stop = isModelContext(context) ? watchModelContext(context) : watchForms();
    },
    disable() {
      stop?.();
      stop = null;
      tools.clear();
    },

    invokeTool(params: Protocol.WebMCP.InvokeToolRequest): Protocol.WebMCP.InvokeToolResponse {
      const tool = params.frameId === FRAME_ID ? tools.get(params.toolName) : undefined;
      if (!tool) throw new CdpError('Tool not found');
      const invocationId = newInvocationId();
      const controller = new AbortController();
      invocations.set(invocationId, controller);
      const input: Record<string, unknown> = { ...params.input };
      // The response goes out before the events, as in Chrome.
      queueMicrotask(async () => {
        server.emit('WebMCP.toolInvoked', {
          toolName: params.toolName,
          frameId: FRAME_ID,
          invocationId,
          input: sortedJson(input),
        } satisfies Protocol.WebMCP.ToolInvokedEvent);
        const outcome = await tool
          .invoke(input, controller.signal)
          .catch((error: unknown): Outcome => ({ status: 'Error', errorText: '', exception: error }));
        invocations.delete(invocationId);
        server.emit('WebMCP.toolResponded', respondedEvent(invocationId, outcome));
      });
      return { invocationId };
    },

    cancelInvocation(params: Protocol.WebMCP.CancelInvocationRequest) {
      const controller = invocations.get(params.invocationId);
      if (!controller) throw new CdpError('Invalid invocation id');
      controller.abort();
    },
  });

  function respondedEvent(invocationId: string, outcome: Outcome): Protocol.WebMCP.ToolRespondedEvent {
    if (outcome.status === 'Completed')
      return { invocationId, status: 'Completed', ...('output' in outcome ? { output: outcome.output } : {}) };
    if (outcome.status === 'Canceled') return { invocationId, status: 'Canceled', errorText: '' };
    return {
      invocationId,
      status: 'Error',
      errorText: outcome.errorText,
      ...('exception' in outcome ? { exception: objects.wrap(outcome.exception) } : {}),
    };
  }
}

// ---- forms ----

/** The form's fields that become tool parameters, grouped by name (radio buttons share one). */
function fieldsOf(form: HTMLFormElement): Map<string, Element[]> {
  const fields = new Map<string, Element[]>();
  for (const el of form.elements) {
    const isField =
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLInputElement && !['submit', 'reset', 'button', 'image', 'hidden', 'file'].includes(el.type));
    const name = el.getAttribute('name');
    if (!isField || !name) continue;
    fields.set(name, [...(fields.get(name) ?? []), el]);
  }
  return fields;
}

/** The input schema Chrome derives from a declarative form. */
function formSchema(form: HTMLFormElement): object {
  const properties: Record<string, object> = {};
  const required: string[] = [];
  for (const [name, group] of fieldsOf(form)) {
    const [el] = group;
    if (!el) continue;
    const description = el.getAttribute('toolparamdescription');
    const extra = description ? { description } : {};
    if (el instanceof HTMLSelectElement) {
      const options = [...el.options];
      properties[name] = {
        type: 'string',
        ...extra,
        anyOf: options.map(o => ({ type: 'string', const: o.value, title: o.text })),
        enum: options.map(o => o.value),
      };
    } else if (el instanceof HTMLInputElement && el.type === 'radio') {
      const values = group.flatMap(radio => (radio instanceof HTMLInputElement ? [radio.value] : []));
      properties[name] = {
        type: 'string',
        ...extra,
        anyOf: values.map(value => ({ type: 'string', const: value })),
        enum: values,
      };
    } else if (el instanceof HTMLInputElement && el.type === 'checkbox') {
      properties[name] = { type: 'boolean', ...extra };
    } else if (el instanceof HTMLInputElement && (el.type === 'number' || el.type === 'range')) {
      const step = el.getAttribute('step');
      const multipleOf = step === 'any' ? undefined : Number(step || 1);
      properties[name] = { type: 'number', ...extra, ...(multipleOf ? { multipleOf } : {}) };
    } else {
      properties[name] = { type: 'string', ...extra };
    }
    if (group.some(field => field.hasAttribute('required'))) required.push(name);
  }
  return { type: 'object', properties, required };
}

/** Fills the form in from the tool's input; returns an error text when the input does not fit. */
function fillForm(form: HTMLFormElement, input: Record<string, unknown>): string | undefined {
  const fields = fieldsOf(form);
  for (const key of Object.keys(input))
    if (!fields.has(key)) return `Input contains a parameter "${key}" but there is no such parameter for the tool`;
  for (const [name, value] of Object.entries(input)) {
    for (const el of fields.get(name) ?? []) {
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(value);
      else if (el instanceof HTMLInputElement && el.type === 'radio') el.checked = el.value === String(value);
      else if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)
        el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  return undefined;
}

/**
 * Runs a declarative tool: fills the form in, then submits it (with `toolautosubmit`) or waits
 * for the user to. Like Chrome's, the submit event has `agentInvoked` and `respondWith()`,
 * whose promise becomes the tool's output; a form that is not prevented is submitted for real.
 */
function submitForm(
  form: HTMLFormElement,
  input: Record<string, unknown>,
  autosubmit: boolean,
  signal: AbortSignal
): Promise<Outcome> {
  const error = fillForm(form, input);
  if (error) return Promise.resolve({ status: 'Error', errorText: error });
  if (
    !autosubmit &&
    !form.querySelector('button:not([type=button]):not([type=reset]), input[type=submit], input[type=image]')
  )
    return Promise.resolve({
      status: 'Error',
      errorText: 'No submit button was found, but for a form without `toolautosubmit`, there must be a submit button',
    });

  return new Promise<Outcome>(resolve => {
    const respond = (event: Event) => {
      form.removeEventListener('submit', respond, true);
      signal.removeEventListener('abort', cancel);
      let response: Promise<unknown> | undefined;
      Object.defineProperties(event, {
        agentInvoked: { value: true },
        respondWith: {
          value: (value: unknown) => {
            response = Promise.resolve(value);
          },
        },
      });
      // Listeners run after this capture listener on the form, so the outcome is read after them.
      setTimeout(() => {
        if (response)
          response.then(
            output => resolve(output === undefined ? { status: 'Completed' } : { status: 'Completed', output }),
            (thrown: unknown) => resolve({ status: 'Error', errorText: '', exception: thrown })
          );
        else resolve({ status: 'Completed' });
      });
    };
    const cancel = () => {
      form.removeEventListener('submit', respond, true);
      resolve({ status: 'Canceled' });
    };
    form.addEventListener('submit', respond, true);
    signal.addEventListener('abort', cancel, { once: true });
    if (autosubmit) {
      const event = new SubmitEvent('submit', { bubbles: true, cancelable: true });
      if (form.dispatchEvent(event)) form.submit();
    }
  });
}
