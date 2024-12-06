const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const EventEmitter = require('events');
const { UART_CONFIG, TIMEOUTS } = require('../config/constants');

class UartService extends EventEmitter {
    constructor(config = UART_CONFIG) {
        super();
        this.config = config;
        this.serialPort = null;
        this.parser = null;
        this.initialized = false;
        this.lastResponse = null;
        // Separate queues for different command types
        this.pendingCommands = new Map();
        this.messageTimeout = TIMEOUTS.UART_RESPONSE_TIMEOUT;
        
        // Commands that don't expect a response
        this.noResponseCommands = [
            'pair_nozzle',
            'set_solenoid',
            'meter_reset'
        ];
    }

    initialize() {
        return new Promise((resolve, reject) => {
            try {
                this.serialPort = new SerialPort({
                    path: this.config.DEFAULT_PATH,
                    baudRate: this.config.BAUD_RATE,
                    dataBits: this.config.DATA_BITS,
                    stopBits: this.config.STOP_BITS,
                    parity: this.config.PARITY
                });

                this.parser = this.serialPort.pipe(new ReadlineParser({ delimiter: this.config.DELIMITER }));

                // Handle incoming data
                this.parser.on('data', this.handleData.bind(this));

                // Handle errors
                this.serialPort.on('error', this.handleError.bind(this));

                this.serialPort.on('open', () => {
                    this.initialized = true;
                    console.log('UART connection established');
                    resolve(true);
                });
            } catch (error) {
                reject(error);
            }
        });
    }


    handleError(error) {
        console.error('UART error:', error);
        this.emit('error', error);

        // Reject all pending commands
        for (const [commandId, { reject, timeout }] of this.pendingCommands.entries()) {
            clearTimeout(timeout);
            reject(error);
            this.pendingCommands.delete(commandId);
        }
    }

    shouldExpectResponse(command) {
        return !this.noResponseCommands.some(cmd => command.startsWith(cmd));
    }

    getCommandType(data) {
        if (data.startsWith('heartbeat')) return 'heartbeat';
        if (data.startsWith('hls_read')) return 'hls_read';
        if (data.startsWith('meter_read')) return 'meter_read';
        if (data.startsWith('rfid_get')) return 'rfid_get';
        // Add other command types as needed
        return 'unknown';
    }

    handleData(data) {
        console.log('Received UART data:', data);
        this.lastResponse = data;
        this.emit('data', data);

        const responseType = this.getCommandType(data);
        
        // Find matching command in the queue
        for (const [commandId, command] of this.pendingCommands.entries()) {
            if (this.getCommandType(command.originalCommand) === responseType) {
                clearTimeout(command.timeout);
                this.pendingCommands.delete(commandId);
                command.resolve(data);
                return;
            }
        }

        // If no matching command found, emit as unexpected response
        console.log(`Received ${responseType} response without matching command:`, data);
    }

    async sendCommand(command, expectResponse = null) {
        if (!this.initialized) {
            throw new Error('UART service not initialized');
        }

        if (expectResponse === null) {
            expectResponse = this.shouldExpectResponse(command);
        }

        return new Promise((resolve, reject) => {
            const formattedCommand = command.endsWith('\n') ? command : `${command}\n`;
            const commandId = Date.now().toString();

            if (expectResponse) {
                const timeout = setTimeout(() => {
                    const command = this.pendingCommands.get(commandId);
                    if (command) {
                        console.log(`Command timed out: ${command.originalCommand}`);
                        this.pendingCommands.delete(commandId);
                        reject(new Error('UART response timeout'));
                    }
                }, this.messageTimeout);

                this.pendingCommands.set(commandId, {
                    resolve,
                    reject,
                    timeout,
                    originalCommand: command,
                    timestamp: Date.now()
                });
            }

            this.serialPort.write(formattedCommand, (err) => {
                if (err) {
                    if (expectResponse) {
                        const command = this.pendingCommands.get(commandId);
                        if (command) {
                            clearTimeout(command.timeout);
                            this.pendingCommands.delete(commandId);
                        }
                    }
                    reject(err);
                    return;
                }

                console.log('Sent UART command:', formattedCommand.trim());
                if (!expectResponse) {
                    resolve(true);
                }
            });
        });
    }

    // Add method to clean up expired messages
    cleanupExpiredMessages() {
        const now = Date.now();
        for (const [commandId, command] of this.pendingCommands.entries()) {
            if (now - command.timestamp > this.messageTimeout) {
                console.log(`Command expired: ${command.originalCommand}`);
                clearTimeout(command.timeout);
                this.pendingCommands.delete(commandId);
                command.reject(new Error('Command expired'));
            }
        }
    }

    // You might want to call this periodically
    startCleanupInterval() {
        setInterval(() => this.cleanupExpiredMessages(), this.messageTimeout / 2);
    }

    isConnected() {
        return this.initialized && this.serialPort && this.serialPort.isOpen;
    }

    parseRfidResponse(response) {
        const match = response.match(/rfid_get\((\d+),([A-Fa-f0-9]+),(\d+)\)/);
        if (match) {
            return {
                nozzleId: match[1],
                rfidTag: match[2],
                batteryState: parseInt(match[3])
            };
        }
        return null;
    }

    parseMeterResponse(response) {
        const match = response.match(/meter_read\((\d+(?:\.\d+)?)\)/);
        return match ? parseFloat(match[1]) : null;
    }

    close() {
        if (this.serialPort && this.serialPort.isOpen) {
            this.serialPort.close();
            this.initialized = false;
        }
    }
}

module.exports = UartService;