type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogEntry {
    timestamp: string;
    level: LogLevel;
    message: string;
    data?: Record<string, unknown>;
}

function formatEntry(entry: LogEntry): string {
    const base = `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}`;
    if (entry.data && Object.keys(entry.data).length > 0) {
        return `${base} ${JSON.stringify(entry.data)}`;
    }
    return base;
}

function createEntry(level: LogLevel, message: string, data?: Record<string, unknown>): LogEntry {
    return {
        timestamp: new Date().toISOString(),
        level,
        message,
        data,
    };
}

export const logger = {
    info(message: string, data?: Record<string, unknown>): void {
        const entry = createEntry('info', message, data);
        console.info(formatEntry(entry)); // eslint-disable-line no-console
    },

    warn(message: string, data?: Record<string, unknown>): void {
        const entry = createEntry('warn', message, data);
        console.warn(formatEntry(entry));
    },

    error(message: string, data?: Record<string, unknown>): void {
        const entry = createEntry('error', message, data);
        console.error(formatEntry(entry));
    },

    debug(message: string, data?: Record<string, unknown>): void {
        if (process.env.NODE_ENV !== 'production') {
            const entry = createEntry('debug', message, data);
            console.info(formatEntry(entry)); // eslint-disable-line no-console
        }
    },
};
