const express = require('express');
const { STATES, TIMEOUTS } = require('../config/constants');
const crypto = require('crypto');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const router = express.Router();




class ApiRoutes {
    constructor(stateMachine, logger, uart) {
        this.stateMachine = stateMachine;
        this.logger = logger;
        this.router = router;
        this.activeTokens = new Map(); // Store active tokens
        this.setupRoutes();
        this.uartService = uart;
        this.initializeUploadMiddleware();
    }

    initializeUploadMiddleware() {
        const storage = multer.diskStorage({
            destination: 'uploads/',
            filename: (req, file, cb) => {
                const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                cb(null, `${uniqueSuffix}-${file.originalname || 'image.jpg'}`);
            }
        });

        // Configure multer to handle raw files
        this.upload = multer({
            storage,
            limits: {
                fileSize: 10 * 1024 * 1024 // 10MB
            },
            // Don't filter files - accept everything
            fileFilter: (req, file, cb) => cb(null, true)
        }).single('file');
    }


    setupRoutes() {
        
        /**
         * GET /api/hls/:socketId
         * Read HLS sensor value
         * Request parameter: socketId (3 or 4)
         * Response format: { hlsId: 3, meterRead: 123, denominator: 500 }
         * 
         * Sample response: { "hlsId": 3, "meterRead": 123, "denominator": 500 }
         * 
         * Sample error response: { "error": "Failed to read HLS sensor" }
        */
        

        this.router.get('/hls/:socketId', async (req, res) => {
            try {
                const socketId = parseInt(req.params.socketId);
                
                // Validate socket ID
                if (socketId !== 3 && socketId !== 4) {
                    return res.status(400).json({
                        success: false,
                        error: 'Invalid HLS socket ID. Must be either 3 or 4.'
                    });
                }

                // The denominator is a service parameter - hardcoded
                const denominator = 500;
                this.logger.debug('Reading HLS sensor', { socketId, denominator });
                // Send UART command and get response
                const response = await this.uartService.sendCommand(`hls_read(${denominator},${socketId})`, true);

                this.logger.debug('HLS read response:', response);

                // Parse the response - assuming response format is like "hls_read(value,socketId)"
                const match = response.match(/hls_read\((\d+),\d+\)/);
                this.logger.debug('HLS read match:', match);
                
                if (!match) {
                    return res.status(400).json({
                        success: false,
                        error: 'Invalid response from HLS sensor'
                    });
                }

                const meterRead = parseInt(match[1]);
                
                // Return the response with a timestamp
                return res.json({
                    success: true,
                    data: {
                        hlsId: socketId,
                        meterRead: meterRead,
                        denominator: denominator,
                        timestamp: Date.now()
                    }
                });

            } catch (error) {
                this.logger.error('HLS read error:', error);
                return res.status(500).json({
                    success: false,
                    error: 'Failed to read HLS sensor'
                });
            }
        });
        
        
        /**
         * Post /api/uart
         * Send command to UART
         * Request body sample for Postman
         * { "command": "pair_nozzle" }
         */
        this.router.post('/uart', async (req, res) => {
            try {
                const { command } = req.body;
                if (!command) {
                    return res.status(400).json({
                        success: false,
                        error: 'Invalid command'
                    });
                }

                // Send command to UART
                const response = await this.uartService.sendCommand(command, false);
                res.json({
                    success: true,
                    data: response
                });
            } catch (error) {
                this.logger.error('UART command error', { error });
                res.status(500).json({
                    success: false,
                    error: 'Failed to send command'
                });
            }

        });

        
        
        /**
         * GET /api/state
         * Get current state of the fuel automation system
         */
        this.router.get('/state', (req, res) => {
            try {
                const stateInfo = this.stateMachine.getStateInfo();
                res.json({
                    success: true,
                    data: stateInfo
                });
            } catch (error) {
                this.logger.error('Error getting state', { error });
                res.status(500).json({
                    success: false,
                    error: 'Failed to get state information'
                });
            }
        });

        /**
         * POST /api/fill
         * Start refill operation
         */
        // Update the API routes to include proper reasons
        this.router.post('/fill', async (req, res) => {
            try {
                const currentState = this.stateMachine.currentState;
                console.log('Current state before fill request:', currentState);

                if (currentState !== STATES.REFILL_OP_IDLE) {
                    return res.status(400).json({
                        success: false,
                        error: 'Cannot start fill operation - system busy',
                        currentState: currentState,
                        allowedState: STATES.REFILL_OP_IDLE
                    });
                }

                this.stateMachine.transition(
                    STATES.REFILL_OP_START,
                    { requestTime: Date.now() },
                    'Fill operation initiated via API request'
                );
                
                this.logger.info('Fill operation started');

                res.json({
                    success: true,
                    message: 'Fill operation started',
                    state: this.stateMachine.getStateInfo()
                });
            } catch (error) {
                this.logger.error('Error starting fill operation', { error });
                res.status(500).json({
                    success: false,
                    error: 'Failed to start fill operation',
                    details: error.message
                });
            }
        });

    /**
     * POST /api/drf-submit
     * Submit DRF (Diesel Request Form) information
     */
    this.router.post('/drf-submit', async (req, res) => {
        try {
            let { kilometers } = req.body;
            
            // Convert to number if it's a string
            if (typeof kilometers === 'string') {
                this.logger.debug('Converting kilometers to number', { kilometers });
                kilometers = parseInt(kilometers);
            }

            // Check if conversion resulted in a valid number
            if (isNaN(kilometers) || !isFinite(kilometers)) {
                this.logger.error('Invalid kilometers value after conversion', { 
                    originalValue: req.body.kilometers,
                    convertedValue: kilometers 
                });
                return res.status(400).json({
                    success: false,
                    error: 'Invalid kilometers value'
                });
            }

            if (kilometers > 1000) {
                this.logger.error('Kilometer reading too high', { kilometers });
                return res.status(400).json({
                    success: false,
                    error: 'Kilometer reading too high'
                });
            }

            if (this.stateMachine.currentState !== STATES.REFILL_WAIT_FOR_DRF_SUBMIT) {
                this.logger.error('Invalid state for DRF submit', { 
                    currentState: this.stateMachine.currentState 
                });
                return res.status(400).json({
                    success: false,
                    error: 'Invalid state for DRF submit',
                    currentState: this.stateMachine.currentState,
                    requiredState: STATES.REFILL_WAIT_FOR_DRF_SUBMIT
                });
            }

            this.stateMachine.transition(STATES.REFILL_READ_FIRST_METER, { kilometers });
            this.logger.info('DRF submitted', { kilometers });

            res.json({
                success: true,
                message: 'DRF submitted successfully',
                state: this.stateMachine.getStateInfo()
            });
        } catch (error) {
            this.logger.error('Error submitting DRF', { error });
            res.status(500).json({
                success: false,
                error: 'Failed to submit DRF'
            });
        }
    });

        /**
         * GET /api/refill-info
         * Get information about the current or last refill operation
         */
        this.router.get('/refill-info', (req, res) => {
            try {
                const transaction = this.stateMachine.currentTransaction;
                if (!transaction) {
                    return res.status(404).json({
                        success: false,
                        error: 'No active transaction'
                    });
                }

                res.json({
                    success: true,
                    data: this.stateMachine.getStateInfo()
                });
            } catch (error) {
                this.logger.error('Error getting refill info', { error });
                res.status(500).json({
                    success: false,
                    error: 'Failed to get refill information'
                });
            }
        });

/**
     * GET /api/debug/state
     * Get detailed state information including meter readings
     */
this.router.get('/debug/state', (req, res) => {
    try {
        const stateInfo = this.stateMachine.getStateInfo();
        const lastHeartbeat = this.stateMachine.lastHeartbeatTime;
        const now = Date.now();

        res.json({
            success: true,
            data: {
                ...stateInfo,
                meter: {
                    current: this.stateMachine.meterReading.current,
                    lastStable: this.stateMachine.meterReading.lastStable,
                    lastSaved: this.stateMachine.meterReading.lastSaved,
                    isStable: this.stateMachine.isMeterReadingStable(),
                    recentReadings: this.stateMachine.meterReading.readings,
                    lastUpdated: this.stateMachine.meterReading.stabilityTimestamp
                },
                heartbeat: {
                    last: new Date(lastHeartbeat).toISOString(),
                    age: now - lastHeartbeat,
                    healthy: (now - lastHeartbeat) < TIMEOUTS.NOZZLE_HEARTBEAT_TIMEOUT
                },
                systemTime: new Date().toISOString()
            }
        });
    } catch (error) {
        this.logger.error('Error getting debug state', { error });
        res.status(500).json({
            success: false,
            error: 'Failed to get debug state information'
        });
    }
});


        /*###########################################################################################################*/
        
        // Ping endpoint
        this.router.get('/ping', (req, res) => {
            res.send('pong');
        });

        // Auth endpoint
        this.router.post('/auth', (req, res) => {
            const { username, state, key, challenge: receivedChallenge } = req.body;

            if (state === 'initial') {
                // Generate a new challenge
                const challenge = crypto.randomUUID();
                res.json({
                    username,
                    challenge,
                    state: 'challenge'
                });
            } else {
                // Verify the challenge response
                const expectedKey = crypto.createHash('md5')
                    .update(`${username}:Minetec123#`)
                    .digest('hex');

                if (key === expectedKey) {
                    const token = crypto.randomUUID();
                    this.activeTokens.set(token, username);

                    res.json({
                        username,
                        key,
                        token,
                        challenge: receivedChallenge,
                        role: 'admin',
                        state: 'authenticated'
                    });
                } else {
                    res.status(401).json({ error: 'Authentication failed' });
                }
            }
        });

        // Operation endpoint (replacing /fill)
        this.router.post('/operation', async (req, res) => {
            try {
                const { request, token, refill_op_workinghours } = req.body;

                if (!this.activeTokens.has(token)) {
                    return res.json({ response: 'invalid_token' });
                }

                switch (request) {
                    case 'refill_req':
                        if (this.stateMachine.currentState !== STATES.REFILL_OP_IDLE) {
                            return res.json({
                                response: 'invalid',
                                message: 'System busy'
                            });
                        }
                        this.stateMachine.transition(
                            STATES.REFILL_OP_START,
                            { requestTime: Date.now() },
                            'Fill operation initiated via API request'
                        );
                        this.logger.info('Fill operation started');

                        return res.json({ response: 'refill_drf' });

                    case 'refill_drf':
                    let  kilometers  = refill_op_workinghours;   
                    this.logger.info('DRF submitted', { kilometers: refill_op_workinghours });
                        try {
                            
                            if (typeof kilometers === 'string') {
                                this.logger.debug('Converting kilometers to number', { kilometers });
                                kilometers = parseInt(kilometers);
                            }
                
                            // Check if conversion resulted in a valid number
                            if (isNaN(kilometers) || !isFinite(kilometers)) {
                                this.logger.error('Invalid kilometers value after conversion', { 
                                    originalValue: req.body.kilometers,
                                    convertedValue: kilometers 
                                });
                                return res.status(400).json({
                                    success: false,
                                    error: 'Invalid kilometers value'
                                });
                            }
                
                            if (kilometers > 1000) {
                                this.logger.error('Kilometer reading too high', { kilometers });
                                return res.status(400).json({
                                    success: false,
                                    error: 'Kilometer reading too high'
                                });
                            }
            
                            if (this.stateMachine.currentState !== STATES.REFILL_WAIT_FOR_DRF_SUBMIT) {
                                this.logger.error('Invalid state for DRF submit', { currentState: this.stateMachine.currentState });
                                return res.status(400).json({
                                    success: false,
                                    error: 'Invalid state for DRF submit',
                                    currentState: this.stateMachine.currentState,
                                    requiredState: STATES.REFILL_WAIT_FOR_DRF_SUBMIT
                                });
                            }
            
                            this.stateMachine.transition(STATES.REFILL_READ_FIRST_METER, { kilometers });
                            this.logger.info('DRF submitted', { kilometers });
            
                            return res.json({ response: 'refill_started' });
                        } catch (error) {
                            this.logger.error('Error submitting DRF', { error });
                            res.status(200).json({
                                response: 'refill_rejected',
                                message: 'Failed to submit DRF: ' + error.message
                            });
                        }

                        case 'refill_params':
                            // Check if we're in a state after refill has ended and tank capacity was reached
                            if (this.stateMachine.currentState === STATES.REFILL_WAIT_APP_INFORM && 
                                this.stateMachine.refillEndReason && 
                                this.stateMachine.refillEndReason.includes('Max Tank Capacity')) {
                                
                                // Mark that we've informed the app
                                this.stateMachine.appInformed = true;
                                
                                // Transition to idle state
                                this.stateMachine.transitionToIdle('Tank capacity reached - app informed');
                                
                                return res.json({
                                    response: 'invalid',
                                    message: 'Tank capacity reached: ' + this.stateMachine.refillLiters
                                });
                            }
                            
                            // Normal operation response
                            return res.json({
                                response: 'refill_params',
                                state: this.stateMachine.currentState,
                                refill_op_rfidtag: this.stateMachine.vehicle?.TagNumber || '',
                                refill_op_fleetnumber: this.stateMachine.vehicle?.FleetNumber || '',
                                refill_op_liters: this.stateMachine.meterReading.current.toString(),
                                refill_op_date_time: new Date().toLocaleString('en-GB').replace(',', '')
                            });

                        case 'refill_finish':
                            this.stateMachine.transition(STATES.REFILL_FORCE_STOP);
                            return res.json({
                                response: 'refill_finished',
                                refill_op_liters: this.stateMachine.meterReading.lastStable.toString()
                            });

                        case 'vehicle_info':
                            if (this.stateMachine.currentState === STATES.REFILL_WAIT_FOR_DRF_SUBMIT) {
                                const vehicle = this.stateMachine.vehicle;
                                const currentTime = new Date();
                                
                                return res.json({
                                    response: 'vehicle_info',
                                    refill_op_rfidtag: vehicle.TagNumber || '',
                                    refill_op_fleetnumber: vehicle.FleetNumber || '',
                                    refill_op_workinghours: vehicle.CurrentMachineHours?.toString() || '0',
                                    refill_op_date_time: currentTime.toLocaleString('en-GB').replace(',', ''),
                                    refill_op_liters: this.stateMachine.meterReading.current.toString()
                                });
                            } else {
                                return res.json({ response: 'tag_waiting' });
                            }
                        
                    default:
                        return res.json({ response: 'invalid' });
                }
            } catch (error) {
                this.logger.error('Operation error', { error });
                res.json({ response: 'invalid', error: error.message });
            }
        });
        
        
        
        this.router.post('/upload', (req, res) => {
            // Get the raw body if this is a multipart request
            let rawData = Buffer.from([]);
            let boundary = '';

            if (req.headers['content-type']) {
                boundary = req.headers['content-type'].split('boundary=')[1];
            }

            // Handle the request based on whether it's from Flutter or Python
            if (boundary && boundary.includes('dart-http-boundary')) {
                this.logger.debug('Processing Flutter upload');
                
                req.on('data', chunk => {
                    rawData = Buffer.concat([rawData, chunk]);
                });

                req.on('end', async () => {
                    try {
                        // Find the content boundaries in the raw data
                        const dataStr = rawData.toString('binary');
                        const parts = dataStr.split(boundary);
                        
                        // Find the part containing the file data
                        const filePart = parts.find(part => part.includes('name="file"'));
                        
                        if (!filePart) {
                            throw new Error('No file data found in request');
                        }

                        // Extract the actual file data
                        const fileDataStart = filePart.indexOf('\r\n\r\n') + 4;
                        const fileDataEnd = filePart.lastIndexOf('\r\n');
                        const fileData = filePart.slice(fileDataStart, fileDataEnd);

                        // Convert to buffer maintaining binary data
                        const buffer = Buffer.from(fileData, 'binary');

                        const filename = `${Date.now()}-flutter-upload.jpg`;
                        const filepath = path.join('uploads', filename);

                        // Write the file
                        await fs.promises.writeFile(filepath, buffer);

                        this.logger.info('Flutter file upload successful', {
                            filename,
                            size: buffer.length,
                            path: filepath,
                            firstBytes: buffer.slice(0, 4).toString('hex')
                        });

                        res.status(200).json({
                            message: 'File uploaded successfully',
                            file: {
                                originalname: filename,
                                size: buffer.length,
                                path: filepath
                            }
                        });
                    } catch (error) {
                        this.logger.error('Error processing Flutter upload', { error });
                        res.status(500).json({
                            error: 'Upload failed',
                            message: error.message
                        });
                    }
                });
            } else {
                // Handle traditional multipart upload (Python case)
                this.upload(req, res, async (err) => {
                    if (err) {
                        this.logger.error('Upload middleware error', { error: err });
                        return res.status(500).json({
                            error: 'Upload failed',
                            details: err.message
                        });
                    }

                    if (!req.file) {
                        return res.status(400).json({
                            error: 'No file uploaded',
                            message: 'No file was received in the request'
                        });
                    }

                    this.logger.info('Multipart file upload successful', {
                        originalname: req.file.originalname,
                        filename: req.file.filename,
                        size: req.file.size,
                        path: req.file.path
                    });

                    res.status(200).json({
                        message: 'File uploaded successfully',
                        file: {
                            originalname: req.file.originalname,
                            size: req.file.size,
                            mimetype: req.file.mimetype
                        }
                    });
                });
            }
        });



        // Error handling middleware
        this.router.use((err, req, res, next) => {
            this.logger.error('API Error', { error: err });
            res.status(500).json({
                success: false,
                error: 'Internal server error'
            });
        });
    }

  
 

    getRouter() {
        return this.router;
    }
}

module.exports = ApiRoutes;