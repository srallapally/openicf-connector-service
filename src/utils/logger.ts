// src/utils/logger.ts
import pino from 'pino';
import type { Logger as PinoLogger } from 'pino';
import { format } from 'node:util';

// OpenICF Log Levels (matching Java implementation)
export enum LogLevel {
    OK = 'OK',       // Maps to FINE/DEBUG
    INFO = 'INFO',   // Maps to INFO
    WARN = 'WARN',   // Maps to WARNING
    ERROR = 'ERROR'  // Maps to SEVERE/ERROR
}

// Configuration for the logger
export interface LoggerConfig {
    level?: string | undefined;
    pretty?: boolean | undefined;
    redactPaths?: string[] | undefined;
    destination?: string | undefined;
}

// OpenICF-style caller information
export interface CallerInfo {
    className?: string | undefined;
    methodName?: string | undefined;
    fileName?: string | undefined;
    lineNumber?: number | undefined;
}

/**
 * OpenICF-compatible Logger implementation using Pino
 * Matches: org.identityconnectors.common.logging.Log
 */
export class Log {
    private pino: PinoLogger;
    private readonly className: string;
    private readonly instanceName: string | undefined;

    private constructor(className: string, instanceName: string | undefined, config: LoggerConfig | undefined) {
        this.className = className;
        this.instanceName = instanceName;

        // Map OpenICF levels to Pino levels
        const levelMap: Record<string, string> = {
            'OK': 'debug',
            'INFO': 'info',
            'WARN': 'warn',
            'ERROR': 'error'
        };

        const configLevel = config?.level;
        const pinoLevel = configLevel
            ? levelMap[configLevel.toUpperCase()] || 'info'
            : process.env.LOG_LEVEL || 'info';

        const loggerName = instanceName
            ? `${className}[${instanceName}]`
            : className;

        // Build redact paths - only if config provided, otherwise use defaults
        const redactPaths = config?.redactPaths ?? [
            'password',
            'token',
            'apiKey',
            'secret',
            'credentials',
            '__password',
            '__ACCOUNT__.password',
            'config.password',
            'config.apiKey',
            'config.clientSecret',
            '*.password',
            '*.token',
            '*.secret',
            '*.credentials'
        ];

        // Determine if pretty printing should be enabled
        const isPretty = config?.pretty ?? (process.env.NODE_ENV !== 'production');

        const pinoConfig: any = {
            level: pinoLevel,
            name: loggerName,

            // Redact sensitive fields
            redact: {
                paths: redactPaths,
                remove: true
            },

            // Serializers for common types
            serializers: {
                err: pino.stdSerializers.err,
                error: pino.stdSerializers.err,
                req: pino.stdSerializers.req,
                res: pino.stdSerializers.res
            },

            // Base fields
            base: {
                env: process.env.NODE_ENV || 'development',
                service: 'openicf-connector-service'
            },

            // Timestamp
            timestamp: pino.stdTimeFunctions.isoTime
        };

        // Only add transport if pretty printing is enabled
        if (isPretty) {
            pinoConfig.transport = {
                target: 'pino-pretty',
                options: {
                    colorize: true,
                    translateTime: 'SYS:standard',
                    ignore: 'pid,hostname',
                    singleLine: false,
                    messageFormat: '[{name}] {msg}'
                }
            };
        }

        this.pino = pino(pinoConfig);
    }

    /**
     * Get the logger for the particular class.
     * Matches: Log.getLog(Class<?> clazz)
     */
    static getLog(className: string, config?: LoggerConfig | undefined): Log {
        return new Log(className, undefined, config);
    }

    /**
     * Get the logger for the particular class with instance name.
     * Matches: Log.getLog(Class<?> clazz, String instanceName)
     */
    static getLogWithInstance(className: string, instanceName: string, config?: LoggerConfig | undefined): Log {
        return new Log(className, instanceName, config);
    }

    /**
     * Determine if it's loggable at this level within this class.
     * Matches: boolean isLoggable(Log.Level level)
     */
    isLoggable(level: LogLevel): boolean {
        const pinoLevel = this.mapLevel(level);
        return this.pino.isLevelEnabled(pinoLevel);
    }

    /**
     * Lowest level logging method.
     * Matches: void log(Class<?> clazz, String method, Level level, String message, Throwable ex)
     */
    log(
        clazz: string,
        method: string,
        level: LogLevel,
        message: string,
        ex: Error | undefined
    ): void {
        const logContext: Record<string, unknown> = {
            className: clazz,
            method
        };

        if (ex !== undefined) {
            logContext.err = ex;
        }

        const pinoLevel = this.mapLevel(level);
        this.pino[pinoLevel](logContext, message);
    }

    /**
     * Logs based on the parameters given. Uses MessageFormat-style formatting.
     * Matches: void log(Level level, Throwable ex, String format, Object... args)
     */
    logFormatted(level: LogLevel, ex: Error | null, formatStr: string, ...args: any[]): void {
        let message: string;

        // Support Java MessageFormat style {0}, {1}, {2}...
        if (formatStr.includes('{') && /\{\d+\}/.test(formatStr)) {
            message = formatStr.replace(/\{(\d+)\}/g, (match, index) => {
                const idx = parseInt(index, 10);
                const arg = args[idx];
                return arg !== undefined ? String(arg) : match;
            });
        } else {
            // Use Node's util.format for %s, %d, %j, etc.
            message = format(formatStr, ...args);
        }

        const caller = this.getCaller();
        const logContext: Record<string, unknown> = {
            className: this.className
        };

        if (this.instanceName !== undefined) {
            logContext.instance = this.instanceName;
        }

        if (caller !== undefined) {
            // Only include caller properties that are defined
            const callerInfo: Record<string, unknown> = {};
            if (caller.methodName !== undefined) callerInfo.method = caller.methodName;
            if (caller.fileName !== undefined) callerInfo.file = caller.fileName;
            if (caller.lineNumber !== undefined) callerInfo.line = caller.lineNumber;

            if (Object.keys(callerInfo).length > 0) {
                logContext.caller = callerInfo;
            }
        }

        if (ex !== null) {
            logContext.err = ex;
        }

        const pinoLevel = this.mapLevel(level);
        this.pino[pinoLevel](logContext, message);
    }

    // ========================================================================
    // Convenience methods matching OpenICF Log API
    // ========================================================================

    /**
     * Log at OK level (debug).
     * Matches: void ok(String message)
     */
    ok(message: string): void {
        if (this.isOk()) {
            const caller = this.getCaller();
            const methodName = caller?.methodName ?? 'unknown';
            this.log(this.className, methodName, LogLevel.OK, message, undefined);
        }
    }

    /**
     * Log at OK level with format string.
     * Matches: void ok(String format, Object... args)
     */
    okFormat(formatStr: string, ...args: any[]): void {
        if (this.isOk()) {
            this.logFormatted(LogLevel.OK, null, formatStr, ...args);
        }
    }

    /**
     * Log at INFO level.
     * Matches: void info(String message)
     */
    info(message: string): void {
        if (this.isInfo()) {
            const caller = this.getCaller();
            const methodName = caller?.methodName ?? 'unknown';
            this.log(this.className, methodName, LogLevel.INFO, message, undefined);
        }
    }

    /**
     * Log at INFO level with format string.
     * Matches: void info(String format, Object... args)
     */
    infoFormat(formatStr: string, ...args: any[]): void {
        if (this.isInfo()) {
            this.logFormatted(LogLevel.INFO, null, formatStr, ...args);
        }
    }

    /**
     * Log at WARN level.
     * Matches: void warn(String message)
     */
    warn(message: string): void {
        if (this.isWarning()) {
            const caller = this.getCaller();
            const methodName = caller?.methodName ?? 'unknown';
            this.log(this.className, methodName, LogLevel.WARN, message, undefined);
        }
    }

    /**
     * Log at WARN level with format string.
     * Matches: void warn(String format, Object... args)
     */
    warnFormat(formatStr: string, ...args: any[]): void {
        if (this.isWarning()) {
            this.logFormatted(LogLevel.WARN, null, formatStr, ...args);
        }
    }

    /**
     * Log at WARN level with exception.
     * Matches: void warn(Throwable ex, String message)
     */
    warnEx(ex: Error, message: string): void {
        if (this.isWarning()) {
            const caller = this.getCaller();
            const methodName = caller?.methodName ?? 'unknown';
            const logContext: Record<string, unknown> = {
                className: this.className,
                method: methodName,
                err: ex
            };
            this.pino.warn(logContext, message);
        }
    }

    /**
     * Log at ERROR level.
     * Matches: void error(String message)
     */
    error(message: string): void {
        if (this.isError()) {
            const caller = this.getCaller();
            const methodName = caller?.methodName ?? 'unknown';
            this.log(this.className, methodName, LogLevel.ERROR, message, undefined);
        }
    }

    /**
     * Log at ERROR level with format string.
     * Matches: void error(String format, Object... args)
     */
    errorFormat(formatStr: string, ...args: any[]): void {
        if (this.isError()) {
            this.logFormatted(LogLevel.ERROR, null, formatStr, ...args);
        }
    }

    /**
     * Log at ERROR level with exception.
     * Matches: void error(Throwable ex, String message)
     */
    errorEx(ex: Error, message: string): void {
        if (this.isError()) {
            const caller = this.getCaller();
            const methodName = caller?.methodName ?? 'unknown';
            const logContext: Record<string, unknown> = {
                className: this.className,
                method: methodName,
                err: ex
            };
            this.pino.error(logContext, message);
        }
    }

    /**
     * Log at ERROR level with exception and format string.
     * Matches: void error(Throwable ex, String format, Object... args)
     */
    errorExFormat(ex: Error, formatStr: string, ...args: any[]): void {
        if (this.isError()) {
            this.logFormatted(LogLevel.ERROR, ex, formatStr, ...args);
        }
    }

    // ========================================================================
    // Level checking methods
    // ========================================================================

    /**
     * Check if OK (debug) level is enabled.
     * Matches: boolean isOk()
     */
    isOk(): boolean {
        return this.pino.isLevelEnabled('debug');
    }

    /**
     * Check if INFO level is enabled.
     * Matches: boolean isInfo()
     */
    isInfo(): boolean {
        return this.pino.isLevelEnabled('info');
    }

    /**
     * Check if WARNING level is enabled.
     * Matches: boolean isWarning()
     */
    isWarning(): boolean {
        return this.pino.isLevelEnabled('warn');
    }

    /**
     * Check if ERROR level is enabled.
     * Matches: boolean isError()
     */
    isError(): boolean {
        return this.pino.isLevelEnabled('error');
    }

    // ========================================================================
    // Extensions beyond OpenICF API
    // ========================================================================

    /**
     * Create child logger with additional context (Pino-specific enhancement).
     */
    child(bindings: Record<string, unknown>): Log {
        const childLogger = new Log(this.className, this.instanceName, undefined);
        childLogger.pino = this.pino.child(bindings);
        return childLogger;
    }

    /**
     * Log with structured context (Pino-specific enhancement).
     */
    logWithContext(
        level: LogLevel,
        message: string,
        context: Record<string, unknown> | undefined,
        error: Error | undefined
    ): void {
        const caller = this.getCaller();
        const methodName = caller?.methodName ?? 'unknown';
        const logContext: Record<string, unknown> = {
            className: this.className,
            method: methodName,
            ...(context ?? {})
        };

        if (error !== undefined) {
            logContext.err = error;
        }

        const pinoLevel = this.mapLevel(level);
        this.pino[pinoLevel](logContext, message);
    }

    // ========================================================================
    // Private helper methods
    // ========================================================================

    private mapLevel(level: LogLevel): 'debug' | 'info' | 'warn' | 'error' {
        switch (level) {
            case LogLevel.OK:
                return 'debug';
            case LogLevel.INFO:
                return 'info';
            case LogLevel.WARN:
                return 'warn';
            case LogLevel.ERROR:
                return 'error';
            default:
                return 'info';
        }
    }

    private getCaller(): CallerInfo | undefined {
        const stack = new Error().stack;
        if (!stack) return undefined;

        const lines = stack.split('\n');
        const callerLine = lines[4] ?? lines[3];
        if (!callerLine) return undefined;

        // Parse stack trace line: "at ClassName.methodName (file:line:col)"
        const match = callerLine.match(/at (?:(.+?)\.)?(.+?) \((.+?):(\d+):\d+\)/);
        if (!match) {
            // Try alternate format: "at file:line:col"
            const simpleMatch = callerLine.match(/at (.+?):(\d+):\d+/);
            if (simpleMatch) {
                const file = simpleMatch[1];
                const lineStr = simpleMatch[2];
                return {
                    fileName: file,
                    lineNumber: lineStr ? parseInt(lineStr, 10) : undefined
                };
            }
            return undefined;
        }

        const className = match[1];
        const methodName = match[2];
        const fileName = match[3];
        const lineStr = match[4];

        return {
            className,
            methodName,
            fileName,
            lineNumber: lineStr ? parseInt(lineStr, 10) : undefined
        };
    }
}

/**
 * Factory function to create loggers (convenience wrapper).
 * Matches OpenICF pattern: Log.getLog(Class.class)
 */
export function getLog(className: string, config?: LoggerConfig | undefined): Log {
    return Log.getLog(className, config);
}

/**
 * Factory function with instance name.
 * Matches OpenICF pattern: Log.getLog(Class.class, instanceName)
 */
export function getLogWithInstance(
    className: string,
    instanceName: string,
    config?: LoggerConfig | undefined
): Log {
    return Log.getLogWithInstance(className, instanceName, config);
}

/**
 * Global logger configuration.
 */
export function configureLogging(config: LoggerConfig): void {
    (global as any).__loggerConfig = config;
}