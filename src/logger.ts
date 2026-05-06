import pino from 'pino';

let _log: pino.Logger | null = null;

export function initLogger(debug: boolean): void {
  _log = pino({
    level: debug ? 'debug' : 'info',
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, ignore: 'pid,hostname' },
    },
  });
}

export function log(): pino.Logger {
  if (!_log) throw new Error('Logger not initialized — call initLogger first');
  return _log;
}
