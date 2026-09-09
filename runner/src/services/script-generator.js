/**
 * Generates a valid k6 script from a request config.
 *
 * k6 scripts are plain JavaScript executed inside the k6 runtime,
 * so we build them as template strings — no extra dependencies needed.
 */

import { hostname as osHostname } from 'os';
const RUNNER_HOSTNAME = osHostname();

/**
 * @param {object} config
 * @param {string} config.url
 * @param {string} config.method       - GET | POST | PUT | PATCH | DELETE
 * @param {object} config.headers      - key/value map
 * @param {any}    config.body         - request body (serialised to JSON if object)
 * @param {number} config.users        - virtual users (vus)
 * @param {string} config.duration     - k6 duration string, e.g. "30s"
 * @param {string} runDir              - absolute path where summary.json / stdout.txt will be written
 * @returns {string} k6 script source code
 */
export function generateScript(config, runDir) {
  const { url, method, headers, body, variables, users, duration, iterations, clientCert, pause, timeout, responseContentType, validationExpression } = config;
  const urlHostname = (() => { try { return new URL(url).hostname; } catch { return url; } })();

  // Serialise headers as a JS object literal inside the script
  const headersLiteral = JSON.stringify(headers || {}, null, 2);

  // Serialise body — k6's http module expects a string.
  // Keep ${...} placeholders intact so resolveTemplate can expand them at runtime.
  let bodyLiteral = 'null';
  if (body !== null && body !== undefined) {
    const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
    bodyLiteral = JSON.stringify(bodyString); // quoted JS string literal
  }

  // Variable definitions — embedded as a constant for runtime lookup
  const variablesLiteral = JSON.stringify(variables || {}, null, 2);

  // Build an optional validation check expression for k6
  let validationCheck = '';
  if (validationExpression && responseContentType && responseContentType !== '*') {
    const expr = JSON.stringify(validationExpression);
    if (responseContentType === 'text') {
      validationCheck = `  'response matches pattern': (r) => new RegExp(${expr}).test(r.body),\n`;
    } else if (responseContentType === 'json') {
      validationCheck = `  'json path exists': (r) => { try { var d = JSON.parse(r.body); var parts = ${expr}.replace(/^\\$\\.?/, '').split('.'); var cur = d; for (var p of parts) { if (cur == null) return false; cur = cur[p]; } return cur !== undefined && cur !== null; } catch { return false; } },\n`;
    } else if (responseContentType === 'xml') {
      validationCheck = `  'xml contains expression': (r) => r.body.includes(${expr}),\n`;
    }
  }

  // Escape the run directory for use inside the script string
  const escapedDir  = runDir.replace(/\\/g, '/');
  const escapedUrl  = url.replace(/\\/g, '\\\\').replace(/`/g, '\\`');

  return `
import http from 'k6/http';
import { check, sleep } from 'k6';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

export const options = {
  // Explicit scenario (rather than top-level vus/duration shorthand) so
  // gracefulStop lives where k6 expects it — the shorthand form trips a
  // "unknown field" warning in some k6 versions even though it's valid.
  scenarios: {
    default: {
      executor: '${iterations ? 'shared-iterations' : 'constant-vus'}',
      vus: ${users},
      ${iterations ? `iterations: ${iterations},\n      maxDuration: '10m',` : `duration: '${duration}',`}
      gracefulStop: '5s',
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  ${clientCert ? `tlsClientCertificates: [{ domains: ['${urlHostname}'], cert: open('./client.crt'), key: open('./client.key') }],` : ''}
};

const HEADERS      = ${headersLiteral};
const URL_TEMPLATE = ${JSON.stringify(url)};
const BODY_TEMPLATE = ${bodyLiteral};
const VARIABLES    = ${variablesLiteral};

// Resolve \${...} placeholders at k6 runtime (per VU, per iteration).
function resolveTemplate(text) {
  return text.replace(/\\$\\{(\\w+)\\}/g, function(_, name) {
    if (name === 'random')       return String(Math.floor(Math.random() * 1000000));
    if (name === 'user')         return String(__VU);
    if (name === 'iteration')    return String(__ITER);
    if (name === 'timestamp')    return String(Date.now());
    if (name === 'isoTimestamp') return new Date().toISOString();
    if (name === 'hostname')     return '${RUNNER_HOSTNAME}';
    var def = VARIABLES[name];
    if (!def || !def.values || !def.values.length) return '';
    if (def.type === 'sequential') return String(def.values[__ITER % def.values.length]);
    if (def.type === 'random')     return String(def.values[Math.floor(Math.random() * def.values.length)]);
    return String(def.values[0]); // constant
  });
}

export default function () {
  const url  = resolveTemplate(URL_TEMPLATE);
  const body = BODY_TEMPLATE !== null ? resolveTemplate(BODY_TEMPLATE) : null;

  const res = http.request('${method}', url, body, { headers: HEADERS, timeout: '${timeout != null ? timeout : '30s'}' });

  check(res, {
    'status is 2xx': (r) => r.status >= 200 && r.status < 300,
${validationCheck}  });

  sleep(${pause != null ? pause : 1});
}

// handleSummary is called once after the test finishes.
// It writes machine-readable JSON and human-readable text to the run directory.
export function handleSummary(data) {
  return {
    '${escapedDir}/summary.json': JSON.stringify(data, null, 2),
    '${escapedDir}/stdout.txt':   textSummary(data, { indent: '  ', enableColors: false }),
    stdout: textSummary(data, { indent: '  ', enableColors: true }),
  };
}
`.trimStart();
}