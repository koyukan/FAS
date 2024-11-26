const { SerialPort } = require('serialport');
const express = require('express');
const { ReadlineParser } = require('@serialport/parser-readline');

const app = express();
const port = 3000;

// Configure your serial port settings here
const serialPort = new SerialPort({
    path: '/dev/ttyUSB0',  // Change this to your port (e.g., 'COM1' on Windows)
    baudRate: 460800,      // Adjust based on your device's baud rate
    dataBits: 8,
    stopBits: 1,
    parity: 'none'
});

// Create a parser for reading line-by-line
const parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }));

// Handle serial port errors
serialPort.on('error', (err) => {
    console.error('Serial Port Error:', err);
});

// Listen for data from the serial port
parser.on('data', (data) => {
    console.log('Received:', data);
});

// Middleware to parse JSON bodies
app.use(express.json());

// API endpoint to send commands to the device
app.post('/uart/send', async (req, res) => {
    const { command } = req.body;
    
    if (!command) {
        return res.status(400).json({ error: 'Command is required' });
    }

    try {
        // Add newline if not present
        const formattedCommand = command.endsWith('\n') ? command : `${command}\n`;
        
        // Write to serial port
        serialPort.write(formattedCommand, (err) => {
            if (err) {
                console.error('Error writing to serial port:', err);
                return res.status(500).json({ error: 'Failed to send command' });
            }
            
            console.log('---- Sent utf8 encoded message:', formattedCommand, '----');
            
            // Wait for response
            let timeout;
            const responseHandler = (data) => {
                clearTimeout(timeout);
                parser.removeListener('data', responseHandler);
                res.json({ response: data });
            };

            // Set timeout for response
            timeout = setTimeout(() => {
                parser.removeListener('data', responseHandler);
                res.status(408).json({ error: 'Response timeout' });
            }, 5000);  // 5 second timeout

            // Listen for the response
            parser.once('data', responseHandler);
        });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`UART Server running at http://localhost:${port}`);
});