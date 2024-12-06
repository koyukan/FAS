const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

// Configuration
const UART_CONFIG = {
    DEFAULT_PATH: '/dev/ttyUSB0',
    BAUD_RATE: 460800,
    DATA_BITS: 8,
    STOP_BITS: 1,
    PARITY: 'none',
    DELIMITER: '\n'
};

// Generate a random number string of specified length
function generateRandomNumbers(length) {
    let result = '';
    for (let i = 0; i < length; i++) {
        result += Math.floor(Math.random() * 10);
    }
    return result;
}

async function testUartMessages() {
    console.log('Starting UART message test...\n');
    
    let serialPort;
    try {
        // Create serial port instance
        console.log('Initializing serial port connection...');
        serialPort = new SerialPort({
            path: UART_CONFIG.DEFAULT_PATH,
            baudRate: UART_CONFIG.BAUD_RATE,
            dataBits: UART_CONFIG.DATA_BITS,
            stopBits: UART_CONFIG.STOP_BITS,
            parity: UART_CONFIG.PARITY
        });

        // Set up parser
        const parser = serialPort.pipe(new ReadlineParser({ delimiter: UART_CONFIG.DELIMITER }));

        // Set up event listeners
        parser.on('data', (data) => {
            console.log('Received response:', data);
        });

        serialPort.on('error', (error) => {
            console.error('Serial port error:', error);
        });

        // Wait for port to open
        await new Promise((resolve, reject) => {
            serialPort.on('open', () => {
                console.log('Serial port opened successfully\n');
                resolve();
            });
            serialPort.on('error', reject);
        });

        // Generate messages once for both tests
        const randomNumbers = generateRandomNumbers(504000);
        const largeMessage = `rfid_get(${randomNumbers})\n`;
        const smallMessage = 'meter_read()\n';
        
        console.log(`Generated large message (${largeMessage.length} bytes)`);
        console.log('First 50 chars:', largeMessage.substring(0, 50));
        console.log('Last 50 chars:', largeMessage.substring(largeMessage.length - 50));
        console.log('\n=== Test 1: With drain() ===\n');

        // Test 1: With drain()
        console.time('Test 1: Large message write (with drain)');
        await new Promise((resolve, reject) => {
            serialPort.write(largeMessage, (error) => {
                if (error) {
                    console.error('Error writing large message:', error);
                    reject(error);
                    return;
                }
                serialPort.drain((error) => {
                    if (error) {
                        console.error('Error draining large message:', error);
                        reject(error);
                        return;
                    }
                    console.log('Large message written and drained');
                    resolve();
                });
            });
        });
        console.timeEnd('Test 1: Large message write (with drain)');

        console.time('Test 1: Small message write (with drain)');
        await new Promise((resolve, reject) => {
            serialPort.write(smallMessage, (error) => {
                if (error) {
                    console.error('Error writing small message:', error);
                    reject(error);
                    return;
                }
                serialPort.drain((error) => {
                    if (error) {
                        console.error('Error draining small message:', error);
                        reject(error);
                        return;
                    }
                    console.log('Small message written and drained');
                    resolve();
                });
            });
        });
        console.timeEnd('Test 1: Small message write (with drain)');

        // Wait a bit between tests
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log('\n=== Test 2: Without drain() ===\n');

        // Test 2: Without drain()
        console.time('Test 2: Large message write (no drain)');
        await new Promise((resolve, reject) => {
            serialPort.write(largeMessage, (error) => {
                if (error) {
                    console.error('Error writing large message:', error);
                    reject(error);
                    return;
                }
                console.log('Large message write callback executed');
                resolve();
            });
        });
        console.timeEnd('Test 2: Large message write (no drain)');

        // Write small message immediately
        console.time('Test 2: Small message write (no drain)');
        await new Promise((resolve, reject) => {
            serialPort.write(smallMessage, (error) => {
                if (error) {
                    console.error('Error writing small message:', error);
                    reject(error);
                    return;
                }
                console.log('Small message write callback executed');
                resolve();
            });
        });
        console.timeEnd('Test 2: Small message write (no drain)');

        // Keep the process alive to observe behavior
        console.log('\nWaiting for 10 seconds to observe behavior...');
        await new Promise(resolve => setTimeout(resolve, 10000));

    } catch (error) {
        console.error('Test failed:', error);
    } finally {
        // Clean up
        if (serialPort && serialPort.isOpen) {
            console.log('Closing serial port...');
            serialPort.close((error) => {
                if (error) {
                    console.error('Error closing port:', error);
                } else {
                    console.log('Serial port closed successfully');
                }
            });
        }
    }
}

// Run the test
console.log('=== UART Buffer Handling Test ===');
testUartMessages().then(() => {
    console.log('Test completed');
}).catch(error => {
    console.error('Test failed:', error);
});