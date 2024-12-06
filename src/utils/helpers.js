const EventEmitter = require('events');

// Time and date utilities
const timeUtils = {
    /**
     * Format date to YYYY-MM-DD HH:mm:ss
     */
    formatDateTime(date = new Date()) {
        return date.toISOString().replace('T', ' ').slice(0, 19);
    },

    /**
     * Check if a timeout has occurred
     */
    isTimedOut(lastTime, timeout) {
        return Date.now() - lastTime > timeout;
    },

    /**
     * Create a timer promise that resolves after specified milliseconds
     */
    createTimeout(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    },

    /**
     * Get elapsed time since a timestamp in seconds
     */
    getElapsedSeconds(timestamp) {
        return Math.floor((Date.now() - timestamp) / 1000);
    }
};

// UART message parsing utilities
const uartUtils = {
    /**
     * Parse RFID message from UART
     * Example: rfid_get(0076,E200001D8914005717701BFC,2013)
     */
    parseRfidMessage(message) {
        const regex = /rfid_get\((\d{4}),([A-Fa-f0-9]{24}),(\d{4})\)/;
        const match = message.match(regex);
        
        if (!match) return null;
        
        return {
            nozzleId: match[1],
            rfidTag: match[2],
            batteryState: parseInt(match[3])
        };
    },

    /**
     * Parse meter reading message
     * Example: meter_read(64.5)
     */
    parseMeterReading(message) {
        const regex = /meter_read\((\d+(?:\.\d+)?)\)/;
        const match = message.match(regex);
        return match ? parseFloat(match[1]) : null;
    },

    /**
     * Parse heartbeat message
     * Example: heartbeat(0)
     */
    parseHeartbeat(message) {
        const regex = /heartbeat\((\d)\)/;
        const match = message.match(regex);
        return match ? parseInt(match[1]) === 0 : false;
    },

    /**
     * Parse RFID match status
     * Example: rfid_match() or rfid_nomatch()
     */
    parseRfidMatchStatus(message) {
        if (message.includes('rfid_match()')) return 'match';
        if (message.includes('rfid_nomatch()')) return 'nomatch';
        return null;
    }
};

// Data validation utilities
const validationUtils = {
    /**
     * Validate RFID tag format
     */
    isValidRfidTag(tag) {
        return /^[A-Fa-f0-9]{24}$/.test(tag);
    },

    /**
     * Validate nozzle ID format
     */
    isValidNozzleId(id) {
        return /^\d{4}$/.test(id);
    },

    /**
     * Validate meter reading
     */
    isValidMeterReading(reading) {
        return !isNaN(reading) && reading >= 0;
    },

    /**
     * Validate machine hours
     */
    isValidMachineHours(hours) {
        return !isNaN(hours) && hours >= 0;
    }
};

// Retry mechanism with exponential backoff
class RetryHandler {
    constructor(maxRetries = 3, baseDelay = 1000, maxDelay = 10000) {
        this.maxRetries = maxRetries;
        this.baseDelay = baseDelay;
        this.maxDelay = maxDelay;
    }

    async retry(operation) {
        let lastError;
        
        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;
                const delay = Math.min(
                    this.baseDelay * Math.pow(2, attempt),
                    this.maxDelay
                );
                await timeUtils.createTimeout(delay);
            }
        }
        
        throw lastError;
    }
}

// Event logging with levels
class Logger extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = {
            logToConsole: true,
            logToFile: false,
            minLevel: 'info',
            ...options
        };
        
        this.levels = {
            debug: 0,
            info: 1,
            warn: 2,
            error: 3
        };
    }

    log(level, message, data = {}) {
        if (this.levels[level] >= this.levels[this.options.minLevel]) {
            const logEntry = {
                timestamp: timeUtils.formatDateTime(),
                level,
                message,
                data
            };

            this.emit('log', logEntry);

            if (this.options.logToConsole) {
                console.log(`[${logEntry.timestamp}] ${level.toUpperCase()}: ${message}`, 
                    Object.keys(data).length ? data : '');
            }
        }
    }

    debug(message, data) { this.log('debug', message, data); }
    info(message, data) { this.log('info', message, data); }
    warn(message, data) { this.log('warn', message, data); }
    error(message, data) { this.log('error', message, data); }
}

// Transaction utilities
const transactionUtils = {
    /**
     * Create new transaction object
     */
    createTransaction(data = {}) {
        return {
            id: null,
            timestamp: timeUtils.formatDateTime(),
            rfidTag: null,
            nozzleId: null,
            startMeterReading: 0,
            endMeterReading: 0,
            dispensedLiters: 0,
            machineHours: 0,
            status: 'initiated',
            ...data
        };
    },

    /**
     * Calculate dispensed amount
     */
    calculateDispensedAmount(startReading, endReading) {
        if (!validationUtils.isValidMeterReading(startReading) || 
            !validationUtils.isValidMeterReading(endReading)) {
            throw new Error('Invalid meter readings');
        }
        return Math.max(0, endReading - startReading);
    }
};

// State machine helpers
const stateUtils = {
    /**
     * Check if transition is allowed
     */
    isValidTransition(currentState, newState, validTransitions) {
        return validTransitions[currentState]?.includes(newState) || false;
    },

    /**
     * Create state change event
     */
    createStateChangeEvent(fromState, toState, data = {}) {
        return {
            timestamp: timeUtils.formatDateTime(),
            fromState,
            toState,
            data
        };
    }
};

module.exports = {
    timeUtils,
    uartUtils,
    validationUtils,
    RetryHandler,
    Logger,
    transactionUtils,
    stateUtils
};