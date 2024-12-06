const EventEmitter = require('events');
const { STATES, TIMEOUTS, DEVICE_CONFIG } = require('../config/constants');
const { timeUtils, validationUtils } = require('../utils/helpers');

class FuelStateMachine extends EventEmitter {
    constructor(uartService, apiService, dbService, logService) {
        super();
        
        // Service dependencies
        this.uart = uartService;
        this.api = apiService;
        this.db = dbService;
        this.logger = logService;
        
        // State management
        this.currentState = STATES.REFILL_OP_IDLE;
        this.previousState = null;
        this.stateData = {};
        this.stateTimestamp = Date.now();
        
        // Meter Reading Management
        this.meterReading = {
            current: 0,           // Current meter value
            lastStable: 0,        // Last stable meter reading
            lastSaved: 0,         // Last saved to database
            stabilityTimestamp: null, // Timestamp of last stable reading
            readings: [],         // Array to track recent readings for stability
            stabilityThreshold: 2,  // Number of consistent readings needed
            stabilityTimeoutMs: 5000 // Time to wait for stability
        };
        
        // Operation data
        this.currentTransaction = null;
        this.vehicle = null;
        
        // Timing and retries
        this.lastHeartbeatTime = Date.now();
        this.lastHeartbeatCheckTime = null;
        this.lastNozzleHeartbeatTime = Date.now();
        this.lastAppCommTime = Date.now();
        this.requestStartTime = null;
        this.retryCount = 0;
        this.maxRetries = 0;
        
        // Device state
        this.nozzleId = DEVICE_CONFIG.DEFAULT_NOZZLE_ID;
        this.solenoidState = false;
        this.rfidLedState = false;
        
        // Operation flags
        this.stopRefill = false;
        this.appInformed = false;
        this.rfidContSent = false;
        this.rfidInContact = false;
        this.rfidAlarmReceived = false;
        
        // Messages
        this.messageToApp = "";
        this.refillEndReason = "";

        // Monitoring
        this.dbIdToSync = -1;
        
        // UART Response Storage
        this.lastRfidResponse = null;
        this.lastMeterResponse = null;
        this.lastAlarmResponse = null;
        this.lastRfidMatchTime = null;
    }

    async initialize() {
        try {
            this.logger.info('\n=== Initializing Fuel State Machine ===');
            
            // Initialize API and fetch fleet data
            this.logger.info('Initializing API connection...');
            await this.api.initialize();
            
            this.logger.info('Fetching fleet data...');
            const fleetData = await this.api.getAvailableTags();
            this.logger.info(`Successfully fetched ${fleetData.length} fleet vehicles`);
            this.logger.info('Fleet data sample:', fleetData[0]);
            
            // Store fleet data
            this.fleetData = fleetData;
            
            // Start heartbeat monitoring
            this.logger.info('Starting heartbeat monitoring...');
            this.startHeartbeatMonitoring();
            
            // Send initial nozzle pairing command
            this.logger.info(`Pairing nozzle ${this.nozzleId}...`);
            await this.uart.sendCommand(`pair_nozzle(${this.nozzleId})`, false);
            
            // Check system health
            this.logger.info('Performing system health check...');
            const heartbeatResponse = await this.uart.sendCommand('heartbeat()', true);
            if (!heartbeatResponse.includes('heartbeat(0)')) {
                throw new Error('System health check failed');
            }
            
            this.logger.info('=== Fuel State Machine Initialization Complete ===\n');
            return true;
        } catch (error) {
            console.error('Failed to initialize Fuel State Machine:', error);
            throw error;
        }
    }

    async processGetFirstRfidState() {
        this.logger.info('\n=== Processing Get First RFID State ===');
        try {
            // Reset app communication timer when starting RFID read process
            if (!this.lastRfidResponse) {
                this.logger.info('Starting new RFID read sequence, resetting app communication timer');
                this.lastAppCommTime = Date.now();
            }
    
            // Check for app communication timeout only after initial RFID contact
            if (this.lastRfidResponse && this.checkAppCommTimeout()) {
                this.transition(
                    STATES.REFILL_OP_IDLE,
                    {},
                    'App communication timeout during RFID read'
                );
                return;
            }
    
            // Check request timeout
            if (this.checkReqTimeout()) {
                if (this.retriesFinished()) {
                    this.logger.info('RFID read max retries reached');
                    this.setRfidLed(false);
                    this.transition(
                        STATES.REFILL_OP_IDLE,
                        {},
                        'Maximum RFID read retries reached'
                    );
                } else {
                    this.logger.info(`RFID read retry attempt ${this.maxRetries - this.retryCount + 1}`);
                    this.retryCount--;
                    await this.uart.sendCommand(`rfid_get(${this.nozzleId})`, true);
                    this.startReqTimer();
                }
            }
    
            // Handle RFID response
            if (this.lastRfidResponse) {
                this.logger.info('\n=== Processing RFID Response ===');
                this.logger.info('Raw response:', this.lastRfidResponse);
                
                const rfidInfo = this.uart.parseRfidResponse(this.lastRfidResponse);
                this.logger.info('Parsed RFID info:', rfidInfo);
    
                if (rfidInfo) {
                    // Reset app communication timer when we get valid RFID response
                    this.lastAppCommTime = Date.now();
                    
                    if (rfidInfo.rfidTag === '-') {
                        this.logger.info('No RFID tag detected, continuing to scan...');
                        this.lastRfidResponse = null;
                        return;
                    }
    
                    // Validate tag against fleet data
                    this.logger.info('Validating RFID tag against fleet database...');
                    this.vehicle = this.fleetData.find(v => v.TagNumber === rfidInfo.rfidTag);
                    
                    if (this.vehicle) {
                        this.logger.info('Valid vehicle found:', {
                            fleetNumber: this.vehicle.FleetNumber,
                            tagNumber: this.vehicle.TagNumber,
                            tankCapacity: this.vehicle.VehicleTankCapacity
                        });
    
                        this.currentTransaction = {
                            ...this.currentTransaction,
                            tagNumber: rfidInfo.rfidTag,
                            vehicleInfo: {
                                fleetNumber: this.vehicle.FleetNumber,
                                tankCapacity: this.vehicle.VehicleTankCapacity
                            }
                        };
    
                        this.transition(
                            STATES.REFILL_WAIT_FOR_DRF_SUBMIT,
                            { vehicle: this.vehicle, rfidInfo },
                            'Valid RFID tag detected and validated'
                        );
                    } else {
                        this.logger.info('Unknown RFID tag - not found in fleet database:', rfidInfo.rfidTag);
                        this.lastRfidResponse = null;
                    }
                }
            }
        } catch (error) {
            console.error('Get first RFID state error:', error);
            this.transition(
                STATES.REFILL_OP_ERROR,
                { error },
                `RFID processing error: ${error.message}`
            );
        }
    }

    async processState() {
        try {
            switch (this.currentState) {
                case STATES.REFILL_OP_IDLE:
                    await this.processIdleState();
                    break;

                case STATES.REFILL_OP_START:
                    await this.processStartState();
                    break;

                case STATES.REFILL_GET_FIRST_RFID:
                    await this.processGetFirstRfidState();
                    break;

                case STATES.REFILL_WAIT_FOR_DRF_SUBMIT:
                    await this.processWaitForDrfState();
                    break;

                case STATES.REFILL_READ_FIRST_METER:
                    await this.processReadFirstMeterState();
                    break;

                case STATES.REFILL_WAIT_FIRST_RFID_MATCH:
                    await this.processWaitFirstRfidMatchState();
                    break;

                case STATES.REFILL_PROGRESS:
                    await this.processRefillProgressState();
                    break;

                case STATES.REFILL_INTERRUPT:
                    await this.processInterruptState();
                    break;

                case STATES.REFILL_LAST_METER_READ:
                    await this.processLastMeterReadState();
                    break;

                case STATES.REFILL_WAIT_METER_STABILITY:
                    await this.processWaitMeterStabilityState();
                    break;

                case STATES.REFILL_WAIT_APP_INFORM:
                    await this.processWaitAppInformState();
                    break;

                case STATES.REFILL_FORCE_STOP:
                    await this.processForceStopState();
                    break;

                case STATES.REFILL_OP_ERROR:
                    await this.processErrorState();
                    break;

                default:
                    console.error(`Invalid state: ${this.currentState}`);
                    this.transition(STATES.REFILL_OP_ERROR, { 
                        reason: 'Invalid state encountered'
                    });
            }
        } catch (error) {
            console.error('State processing error:', error);
            this.transition(STATES.REFILL_OP_ERROR, { error });
        }
    }

    async processIdleState() {
        // Check heartbeat timeout
        if (Date.now() - this.lastHeartbeatTime > TIMEOUTS.NOZZLE_HEARTBEAT_TIMEOUT) {
            this.transition(STATES.REFILL_OP_ERROR, { reason: 'Heartbeat timeout' });
            return;
        }

        // Send periodic heartbeat check
        if (!this.lastHeartbeatCheckTime || Date.now() - this.lastHeartbeatCheckTime > 10000) {
            try {
                const response = await this.uart.sendCommand('heartbeat()', true);
                if (response.includes('heartbeat(0)')) {
                    this.lastHeartbeatTime = Date.now();
                }
                this.lastHeartbeatCheckTime = Date.now();
            } catch (error) {
                console.error('Heartbeat check failed:', error);
            }
        }
    }

    transition(newState, data = {}, reason) {
        if (!reason) {
            console.warn('State transition attempted without reason!');
            reason = 'No reason provided';
        }

        const timestamp = Date.now();
        this.logger.info('\n=== State Transition ===');
        this.logger.info(`From: ${this.currentState}`);
        this.logger.info(`To: ${newState}`);
        this.logger.info(`Reason: ${reason}`);
        this.logger.info('Data:', data);
        
        this.previousState = this.currentState;
        this.currentState = newState;
        this.stateData = { ...data };
        this.stateTimestamp = timestamp;

        // Store the transition details
        const transitionDetails = {
            from: this.previousState,
            to: this.currentState,
            reason: reason,
            data: this.stateData,
            timestamp: this.stateTimestamp
        };

        // Store in history
        if (!this.stateHistory) this.stateHistory = [];
        this.stateHistory.push(transitionDetails);

        // Emit the event
        this.emit('stateChange', transitionDetails);
    }


    /**
     * Reset state machine to accept new requests
     * Used when returning to IDLE state
     */
    resetStateMachine() {
        this.logger.info('\n=== Resetting State Machine ===');
        
        // Reset meter reading management
        this.meterReading = {
            current: 0,
            lastStable: 0,
            lastSaved: 0,
            stabilityTimestamp: null,
            readings: [],
            stabilityThreshold: 2,
            stabilityTimeoutMs: 5000
        };
        
        // Reset all operation data
        this.currentTransaction = null;
        this.vehicle = null;
        
        // Reset operation flags
        this.stopRefill = false;
        this.appInformed = false;
        this.rfidContSent = false;
        this.rfidInContact = false;
        this.rfidAlarmReceived = false;
        
        // Reset UART response storage
        this.lastRfidResponse = null;
        this.lastMeterResponse = null;
        this.lastAlarmResponse = null;
        
        // Reset timers and counters
        this.requestStartTime = null;
        this.lastNozzleHeartbeatTime = Date.now();
        this.retryCount = 0;
        this.lastRfidMatchTime = null;
        
        // Reset messages
        this.messageToApp = "";
        this.refillEndReason = "";

        this.logger.info('State machine reset complete with meter tracking cleanup');
    }

    /**
     * Transition to IDLE state with proper cleanup
     * @param {string} reason - Reason for transitioning to IDLE
     * @param {Object} data - Additional data for the transition
     */
    transitionToIdle(reason, data = {}) {
        // First reset the state machine
        this.resetStateMachine();
        
        // Then perform the transition
        this.transition(STATES.REFILL_OP_IDLE, data, reason);
    }

    /**
     * Initialize refill operation parameters
     */
    initializeRefill() {
        // Reset meter reading management
        this.meterReading = {
            current: 0,
            lastStable: 0,
            lastSaved: 0,
            stabilityTimestamp: null,
            readings: [],
            stabilityThreshold: 2,
            stabilityTimeoutMs: 5000
        };

        // Reset transaction data
        this.currentTransaction = {
            id: null,
            tagNumber: null,
            pumpId: null,
            operatorId: null,
            createDate: new Date().toISOString(),
            createUser: null,
            dispensedLiter: "0",
            currentMachineHours: 0,
            lastSavedLiters: 0,
            synced: false
        };

        // Reset vehicle and operation data
        this.vehicle = null;
        
        // Reset operation flags
        this.stopRefill = false;
        this.appInformed = false;
        this.rfidContSent = false;
        this.rfidInContact = false;
        this.rfidAlarmReceived = false;
        
        // Reset messages
        this.messageToApp = "";
        this.refillEndReason = "";
        
        // Reset timing data
        this.requestStartTime = null;
        this.lastAppCommTime = Date.now();  // Add this
        this.lastNozzleHeartbeatTime = Date.now();  // Add this
        this.lastHeartbeatTime = Date.now();  // Add this
        
        // Reset UART response storage
        this.lastRfidResponse = null;
        this.lastMeterResponse = null;
        this.lastAlarmResponse = null;
        this.lastRfidMatchTime = null;

        this.logger.info('Refill operation initialized with reset meter tracking');
    }

    async processStartState() {
        try {
            // Reset app communication time when starting new operation
            this.lastAppCommTime = Date.now(); // Add this line
            
            // Initialize refill operation
            this.initializeRefill();
            this.retryCount = DEVICE_CONFIG.MAX_RETRIES;
            
            // Request RFID read
            await this.uart.sendCommand(`rfid_get(${this.nozzleId})`, true);
            this.startReqTimer();
            
            // Transition to waiting for RFID
            this.transition(
                STATES.REFILL_GET_FIRST_RFID,
                { maxRetries: this.retryCount },
                'Starting RFID read sequence'
            );
        } catch (error) {
            console.error('Start state error:', error);
            this.transitionToIdle('Error during start state: ' + error.message);
        }
    }

    async processGetFirstRfidState() {
        try {
            // Check for app communication timeout
            if (this.checkAppCommTimeout()) {
                this.transition(STATES.REFILL_OP_IDLE, {}, 'App communication timeout during RFID read');
                return;
            }

            // Check request timeout
            if (this.checkReqTimeout()) {
                if (this.retriesFinished()) {
                    this.logger.info('RFID read max retries reached');
                    this.setRfidLed(false);
                    this.transition(STATES.REFILL_OP_IDLE, {}, 'Maximum RFID read retries reached');
                } else {
                    this.retryCount--;
                    await this.uart.sendCommand(`rfid_get(${this.nozzleId})`, true);
                    this.startReqTimer();
                }
            }

            // Handle RFID response from UART event handler
            if (this.lastRfidResponse) {
                const rfidInfo = this.uart.parseRfidResponse(this.lastRfidResponse);
                if (rfidInfo) {
                    if (rfidInfo.rfidTag === '-') {
                        // No tag detected, continue trying
                        this.logger.info('No RFID tag detected, continuing to scan...');
                        this.lastRfidResponse = null; // Clear the response for next try
                        return;
                    }

                    // Valid tag received
                    this.vehicle = await this.api.validateTag(rfidInfo.rfidTag);
                    if (this.vehicle) {
                        this.logger.info('Valid RFID tag detected:', rfidInfo.rfidTag);
                        this.currentTransaction = {
                            ...this.currentTransaction,
                            tagNumber: rfidInfo.rfidTag
                        };
                        this.transition(STATES.REFILL_WAIT_FOR_DRF_SUBMIT, {
                            vehicle: this.vehicle,
                            rfidInfo
                        }, 'Valid RFID tag detected');  
                    } else {
                        this.logger.info('Unknown RFID tag:', rfidInfo.rfidTag);
                        this.lastRfidResponse = null; // Clear for next try
                    }
                }
            }
        } catch (error) {
            console.error('Get first RFID state error:', error);
            this.transition(STATES.REFILL_OP_ERROR, { error }, 'Error during RFID read');
        }
    }

    async processWaitForDrfState() {
        try {
            // Check for app communication timeout
            if (this.checkAppCommTimeout()) {
                await this.uart.sendCommand(`rfid_get_stop(${this.nozzleId})`, false);
                this.setRfidLed(false);
                this.transitionToIdle('DRF submission timed out - app communication lost');
                return;
            }

            // Check DRF submit timeout
            if (this.checkReqTimeout(TIMEOUTS.DRF_SUBMIT_TIMEOUT)) {
                await this.uart.sendCommand(`rfid_get_stop(${this.nozzleId})`, false);
                this.setRfidLed(false);
                this.transitionToIdle('DRF submission timed out - no submission received within time limit');
                this.logEvent('REFILL END - DRF TIMEOUT');
            }
        } catch (error) {
            console.error('Wait for DRF state error:', error);
            this.transition(
                STATES.REFILL_OP_ERROR, 
                { error },
                `Error in DRF wait state: ${error.message}`
            );
        }
    }

    async processReadFirstMeterState() {
        try {
            const meterValue = await this.getMeterValue();
            if (meterValue !== null) {
                // Meter is active, proceed with refill
                await this.uart.sendCommand('meter_reset()', false);
                await this.uart.sendCommand('meter_read()', true);
                
                
                this.setRfidLed(false);
                this.transition(STATES.REFILL_WAIT_FIRST_RFID_MATCH, {}, 'Meter read successful');
                this.startReqTimer();
                this.retryCount = 150; // 5 minutes timeout
                
                this.logEvent(`REFILL START ${this.vehicle.FleetNumber}`);
            } else if (this.checkReqTimeout(2000)) {
                if (this.retriesFinished()) {
                    await this.uart.sendCommand(`rfid_get_stop(${this.nozzleId})`, false);
                    await this.setSolenoidState(false);
                    this.playSound('METER_READ_ERROR');
                    this.transition(STATES.REFILL_OP_IDLE, {}, 'Meter read error');
                    this.messageToApp = "Meter read error";
                    this.logEvent('REFILL END - METER READ ERROR');
                } else {
                    await this.uart.sendCommand('meter_read()', true);
                    this.startReqTimer();
                }
            }
        } catch (error) {
            console.error('Read first meter state error:', error);
            this.transition(STATES.REFILL_OP_ERROR, { error }, `Error during first meter read: ${error.message}`);
        }
    }

    async processWaitFirstRfidMatchState() {
        try {
            // First send continuous RFID read command if not sent yet
            if (!this.rfidContSent) {
                this.logger.info(`Starting continuous RFID read for tag: ${this.vehicle.TagNumber}`);
                await this.uart.sendCommand(
                    `rfid_get_cont(${this.nozzleId},${this.vehicle.TagNumber})`,
                    false
                );
                this.rfidContSent = true;
                this.startReqTimer();
            }

            // Check if we have a confirmed RFID match
            if (this.rfidInContact && this.lastRfidMatchTime) {
                this.logger.info('Processing confirmed RFID match');
                
                // Add transaction to database
                if (!await this.addTransactionToDb()) {
                    this.messageToApp = "Database Error";
                    this.refillEndReason = "Database Error";
                    this.transition(
                        STATES.REFILL_WAIT_APP_INFORM, 
                        {}, 
                        'Database error while creating transaction'
                    );
                    return;
                }

                // Setup for refill
                await this.setSolenoidState(true);
                await this.uart.sendCommand('meter_read()', true);
                
                this.setRfidLed(true);
                this.playSound('RFID_SUCCESSFUL_READ');

                // Move to refill progress
                this.transition(
                    STATES.REFILL_PROGRESS, 
                    { 
                        matchTime: this.lastRfidMatchTime,
                        rfidTag: this.vehicle.TagNumber
                    }, 
                    'RFID match confirmed, proceeding to refill'
                );
            } else if (this.checkReqTimeout(5000)) {
                if (this.retriesFinished()) {
                    this.logger.info('RFID match timeout - max retries reached');
                    await this.uart.sendCommand(`rfid_stop(${this.nozzleId})`, false);
                    this.messageToApp = "Failed to get RFID match";
                    this.transition(
                        STATES.REFILL_OP_IDLE, 
                        {}, 
                        'RFID match timeout after maximum retries'
                    );
                }
            }
        } catch (error) {
            console.error('Wait first RFID match state error:', error);
            this.transition(
                STATES.REFILL_OP_ERROR, 
                { error }, 
                `Error during RFID match: ${error.message}`
            );
        }
    }

    async processInterruptState() {
        try {
            // Check app comm timeout during interrupt
            if (this.checkAppCommTimeout()) {
                this.messageToApp = "App comm. timeout";
                this.refillEndReason = this.messageToApp;
                
                await this.setSolenoidState(false);
                await this.uart.sendCommand(`rfid_stop(${this.nozzleId})`, false);
                await this.uart.sendCommand('meter_read()', true);
                
                this.startReqTimer();
                this.retryCount = 2;
                this.transition(
                    STATES.REFILL_LAST_METER_READ, 
                    {}, 
                    'App communication timeout during interrupt'
                );
                this.setRfidLed(false);
                return;
            }

            // Check for RFID response in interrupt state
            if (this.lastRfidResponse) {
                const rfidInfo = this.uart.parseRfidResponse(this.lastRfidResponse);
                if (rfidInfo && rfidInfo.rfidTag === this.vehicle.TagNumber) {
                    await new Promise(resolve => setTimeout(resolve, 100));  // Wait 100ms before next command
                    
                    // Clear any alarms
                    this.rfidAlarmReceived = false;
                    
                    this.logEvent(`REFILL RECOVER ${this.retryCount}`);
                    
                    // Start continuous RFID read again
                    await this.uart.sendCommand(
                        `rfid_get_cont(${this.nozzleId},${this.vehicle.TagNumber})`,
                        false
                    );
                    
                    await this.setSolenoidState(true);
                    
                    this.startReqTimer();
                    this.playSound('RFID_SUCCESSFUL_READ');
                    this.setRfidLed(true);
                    
                    this.transition(
                        STATES.REFILL_PROGRESS, 
                        {}, 
                        'RFID tag detected again, resuming refill'
                    );
                    this.messageToApp = "";
                    this.lastRfidResponse = null;
                }
            } else if (this.checkReqTimeout(TIMEOUTS.RFID_RETRY_INTERVAL)) {
                if (this.retriesFinished()) {
                    this.logger.info('Max retries reached in interrupt state');
                    await this.uart.sendCommand(`rfid_stop(${this.nozzleId})`, false);
                    
                    this.messageToApp = "Nozzle removed. Ending refill.";
                    this.refillEndReason = "Nozzle removed. Refill Ended";
                    
                    this.transition(
                        STATES.REFILL_LAST_METER_READ, 
                        {}, 
                        'Maximum retry attempts reached during interrupt'
                    );
                    
                    this.logEvent(`REFILL END - RFID TIMEOUT ${this.maxRetries}`);
                } else {
                    this.logger.info(`Sending RFID read request (retry ${this.maxRetries - this.retryCount})`);
                    await this.uart.sendCommand(`rfid_get(${this.nozzleId})`, true);
                    this.retryCount--;
                    this.playSound('REFILL_INTERRUPT_RFID_REQUEST');
                    this.startReqTimer();
                }
            }
        } catch (error) {
            console.error('Interrupt state error:', error);
            this.transition(
                STATES.REFILL_OP_ERROR, 
                { error }, 
                `Error during interrupt handling: ${error.message}`
            );
        }
    }

/**
 * Process last meter read state - confirms final dispensed amount
 */
async processLastMeterReadState() {
    this.logger.info('\n=== Processing Last Meter Read State ===');
    try {
        // Get current meter value
        const meterValue = await this.getMeterValue();
        if (meterValue !== null) {
            // Compare with previous reading
            if (this.meterReading.lastStable !== meterValue) {
                this.logger.info(`METER READ UNSTABLE ${meterValue}`);
                this.meterReading.current = meterValue;
                this.lastMeterReadLiters = meterValue;
                
                this.transition(
                    STATES.REFILL_WAIT_METER_STABILITY,
                    { 
                        currentReading: meterValue,
                        previousReading: this.meterReading.lastStable
                    },
                    'Meter read unstable'
                );
                
                this.startReqTimer();
                this.playSound('METER_WAIT_STABILITY');
            } else {
                // Reading is stable, finalize the transaction
                await this.finalizeTransaction(meterValue);
            }
        } else if (this.checkReqTimeout(TIMEOUTS.METER_STABILITY_TIMEOUT)) {
            this.logger.info(`TIMEOUT LAST METER READ #${this.retryCount}`);
            
            if (this.retriesFinished()) {
                // Use last known stable reading if we timeout
                await this.finalizeTransaction(this.meterReading.lastStable);
            } else {
                this.retryCount--;
                await this.uart.sendCommand('meter_read()', true);
                this.startReqTimer();
            }
        }
    } catch (error) {
        this.logger.error('Last meter read state error:', error);
        this.transition(
            STATES.REFILL_OP_ERROR,
            { error },
            `Error during last meter read: ${error.message}`
        );
    }
}

/*
* Process wait meter stability state - ensures reading is stable
*/
async processWaitMeterStabilityState() {
   try {
       if (this.checkReqTimeout(5000)) {
           this.logger.info(`LAST METER READ ${this.meterReading.current}`);
           this.retryCount = 2;
           this.transition(
               STATES.REFILL_LAST_METER_READ,
               {
                   lastReading: this.meterReading.current,
                   stabilityAttempt: true
               },
               'Try to read last meter value again'
           );
           await this.uart.sendCommand('meter_read()', true);
           this.startReqTimer();
       }
   } catch (error) {
       this.logger.error('Wait meter stability state error:', error);
       this.transition(
           STATES.REFILL_OP_ERROR,
           { error },
           `Error during meter stability wait: ${error.message}`
       );
   }
}

    /**
     * Finalize transaction with confirmed meter reading
     */
    async finalizeTransaction(finalReading) {
        this.logger.info(`Finalizing transaction with reading: ${finalReading}`);
        
        if (finalReading > 0) {
            this.meterReading.current = finalReading;
            this.currentTransaction.dispensedLiter = finalReading.toString();
            
            this.logEvent(`REFILL COMPLETE ${this.vehicle.FleetNumber} ${finalReading}L`);
            
            // Update database records
            await this.updateTransactionLiters();
            await this.addLitersDispensed(finalReading);
            await this.clearIncompleteTransaction();

            // Update vehicle hours if available
            if (await this.updateVehicleHours()) {
                this.logger.info(`Vehicle Hours Updated with ${this.currentTransaction.CurrentMachineHours}`);
            } else {
                this.logger.info("Vehicle Hours Update FAILED");
            }

            this.playSound('TRANSACTION_ADDED_TO_DB');
            this.dbIdToSync = -1;
        } else {
            this.logEvent(`0L DISPENSE ${this.vehicle.FleetNumber}`);
            await this.deleteTransaction();
            await this.clearIncompleteTransaction();
        }

        // Prepare for app inform
        this.appInformed = false;
        this.startReqTimer();
        this.retryCount = 1;
        
        this.transition(
            STATES.REFILL_WAIT_APP_INFORM,
            { 
                finalReading,
                transactionCompleted: finalReading > 0
            },
            'Transaction finalized, waiting for app to fetch data'
        );
    }

    /**
     * Process wait app inform state - ensures app gets final status
     */
    async processWaitAppInformState() {
        try {
            if (this.checkReqTimeout(TIMEOUTS.APP_INFORM_TIMEOUT) || this.appInformed) {
                if (this.meterReading.current === 0) {
                    await this.checkZeroLiterDispense();
                }
                this.transitionToIdle('App informed or timeout reached');
                this.messageToApp = "";
            }
        } catch (error) {
            this.logger.error('Wait app inform state error:', error);
            this.transition(
                STATES.REFILL_OP_ERROR,
                { error },
                `Error during app inform wait: ${error.message}`
            );
        }
    }

/**
 * Process force stop state - handles user-initiated stops
 */
async processForceStopState() {
    this.logger.info('\n=== Processing Force Stop State ===');
    try {
        // First ensure we get a final reading
        const finalReading = await this.getMeterValue();
        this.logger.info(`Force stop final reading: ${finalReading}`);
        
        // Immediately close valves and stop RFID
        await this.setSolenoidState(false);
        await this.uart.sendCommand(`rfid_stop(${this.nozzleId})`, false);
        
        // Log the event
        this.logEvent('REFILL END - USER REQUEST');
        this.messageToApp = "Refill ended by user";
        
        if (finalReading !== null && finalReading > 0) {
            // Update meter readings
            this.meterReading.current = finalReading;
            this.meterReading.lastStable = finalReading;
            this.currentTransaction.dispensedLiter = finalReading.toString();
            
            // Transition to last meter read for confirmation
            this.retryCount = 2;
            this.transition(
                STATES.REFILL_LAST_METER_READ,
                {
                    finalReading: finalReading,
                    source: 'force_stop',
                    reason: 'User requested stop'
                },
                'Force stop with final reading obtained'
            );
        } else {
            // If we couldn't get a reading, use last known stable reading
            const lastKnownReading = this.meterReading.lastStable;
            if (lastKnownReading > 0) {
                this.meterReading.current = lastKnownReading;
                this.currentTransaction.dispensedLiter = lastKnownReading.toString();
                this.retryCount = 2;
                this.transition(
                    STATES.REFILL_LAST_METER_READ,
                    {
                        finalReading: lastKnownReading,
                        source: 'force_stop',
                        reason: 'Using last stable reading'
                    },
                    'Force stop with last stable reading'
                );
            } else {
                this.logEvent('0L DISPENSE - NO VALID READING');
                this.transition(
                    STATES.REFILL_WAIT_APP_INFORM,
                    { reason: 'No valid reading available' },
                    'Force stop with no valid reading'
                );
            }
        }

        this.setRfidLed(false);
    } catch (error) {
        this.logger.error('Force stop state error:', error);
        this.transition(
            STATES.REFILL_OP_ERROR,
            { error },
            `Error during force stop: ${error.message}`
        );
    }
}

 /**
     * Enhanced error state processing with recovery attempts
     */
 async processErrorState() {
    this.logger.info('\n=== Processing Error State ===');
    try {
        const errorDuration = Date.now() - this.stateTimestamp;
        const errorDetails = this.stateData.error || { message: 'Unknown error' };
        
        // Log error state details
        this.logger.info('Current error state details:', {
            duration: errorDuration,
            error: errorDetails,
            recoveryAttempts: this.recoveryAttempts || 0
        });

        // Initialize recovery attempts counter if not exists
        if (!this.recoveryAttempts) {
            this.recoveryAttempts = 0;
        }

        // Attempt recovery after delay
        if (errorDuration > 5000 && this.recoveryAttempts < 3) {
            await this.attemptSystemRecovery();
        } else if (errorDuration > 30000) {
            this.logger.error('Error state persisted too long, forcing reset');
            await this.forceSystemReset();
        }

    } catch (recoveryError) {
        this.logger.error('Error during error state processing:', recoveryError);
        this.stateTimestamp = Date.now(); // Reset timer for next attempt
    }
}

/**
     * Attempt system recovery from error state
     */
async attemptSystemRecovery() {
    this.logger.info('\n=== Attempting System Recovery ===');
    try {
        this.recoveryAttempts++;
        
        // Step 1: Check basic communication
        const heartbeatResponse = await this.uart.sendCommand('heartbeat()', true);
        if (!heartbeatResponse.includes('heartbeat(0)')) {
            throw new Error('Basic communication check failed');
        }

        // Step 2: Reset device states
        await this.resetDeviceStates();

        // Step 3: Verify meter communication
        const meterResponse = await this.uart.sendCommand('meter_read()', true);
        if (!this.uart.parseMeterResponse(meterResponse)) {
            throw new Error('Meter communication check failed');
        }

        // Step 4: Check RFID system
        await this.uart.sendCommand(`rfid_get(${this.nozzleId})`, true);

        // If all checks pass, attempt to restore normal operation
        await this.restoreOperation();

    } catch (error) {
        this.logger.error('Recovery attempt failed:', error);
        await this.handleRecoveryFailure(error);
    }
}

/**
     * Reset all device states during recovery
     */
async resetDeviceStates() {
    this.logger.info('Resetting device states');
    
    // Close solenoid
    await this.setSolenoidState(false);
    
    // Stop RFID reading
    await this.uart.sendCommand(`rfid_stop(${this.nozzleId})`, false);
    
    // Reset LED states
    this.setRfidLed(false);
    
    // Reset meter
    await this.uart.sendCommand('meter_reset()', false);
    
    // Reset internal states
    this.meterReading = {
        current: 0,
        lastStable: 0,
        lastSaved: 0,
        stabilityTimestamp: null,
        readings: [],
        stabilityThreshold: 2,
        stabilityTimeoutMs: 5000
    };
}

 /**
     * Attempt to restore normal operation
     */
 async restoreOperation() {
    this.logger.info('Attempting to restore normal operation');

    // Check if we were in the middle of a transaction
    if (this.currentTransaction && this.meterReading.lastStable > 0) {
        this.logger.info('Incomplete transaction detected, attempting to save');
        
        // Save the last known good reading
        this.currentTransaction.dispensedLiter = this.meterReading.lastStable.toString();
        await this.updateTransactionLiters();
        
        // Transition to app inform state
        this.transition(
            STATES.REFILL_WAIT_APP_INFORM,
            {
                finalReading: this.meterReading.lastStable,
                recovery: true
            },
            'Restored from error with incomplete transaction'
        );
    } else {
        // If no transaction or no fuel dispensed, reset to idle
        this.resetStateMachine();
        this.transition(
            STATES.REFILL_OP_IDLE,
            { recovery: true },
            'Restored from error to idle state'
        );
    }

    // Reset recovery attempts counter
    this.recoveryAttempts = 0;
}

 /**
     * Handle recovery failure
     */
 async handleRecoveryFailure(error) {
    this.logger.error('Recovery failed:', error);
    
    // If we have pending transaction data, try to save it
    if (this.currentTransaction && this.meterReading.lastStable > 0) {
        try {
            await this.emergencyTransactionSave();
        } catch (saveError) {
            this.logger.error('Emergency transaction save failed:', saveError);
        }
    }

    // Emit recovery failure event
    this.emit('recoveryFailure', {
        error,
        recoveryAttempts: this.recoveryAttempts,
        timestamp: Date.now()
    });
}

/**
 * Emergency save of transaction data
 */
async emergencyTransactionSave() {
    this.logger.info('Attempting emergency transaction save');
    
    try {
        // Save current transaction state
        await this.updateTransactionLiters();
        
        // Log the emergency save
        this.logEvent(`EMERGENCY SAVE - ${this.meterReading.lastStable}L`);
        
        // Mark transaction for review
        await this.db.markTransactionForReview(this.currentTransaction.id);
        
    } catch (error) {
        this.logger.error('Emergency save failed:', error);
        throw error;
    }
}

/**
 * Force a complete system reset
 */
async forceSystemReset() {
    this.logger.info('\n=== Forcing System Reset ===');
    
    try {
        // Stop all active operations
        await this.setSolenoidState(false);
        await this.uart.sendCommand(`rfid_stop(${this.nozzleId})`, false);
        await this.uart.sendCommand('meter_reset()', false);
        
        // Reset all internal states
        this.resetStateMachine();
        
        // Clear all intervals and timeouts
        this.cleanup();
        
        // Reinitialize monitoring systems
        await this.initialize();
        
        // Transition to idle
        this.transition(
            STATES.REFILL_OP_IDLE,
            { forceReset: true },
            'Force reset completed'
        );
        
    } catch (error) {
        this.logger.error('Force reset failed:', error);
        // If force reset fails, we might need manual intervention
        this.emit('criticalError', {
            error,
            message: 'Force reset failed - manual intervention required',
            timestamp: Date.now()
        });
    }
}

/**
 * System diagnostics
 */
async runDiagnostics() {
    this.logger.info('\n=== Running System Diagnostics ===');
    
    const diagnostics = {
        timestamp: Date.now(),
        tests: {},
        status: 'unknown'
    };

    try {
        // Test UART communication
        diagnostics.tests.uart = await this.testUartCommunication();
        
        // Test meter system
        diagnostics.tests.meter = await this.testMeterSystem();
        
        // Test RFID system
        diagnostics.tests.rfid = await this.testRfidSystem();
        
        // Test solenoid control
        diagnostics.tests.solenoid = await this.testSolenoidControl();
        
        // Determine overall status
        diagnostics.status = Object.values(diagnostics.tests)
            .every(test => test.status === 'pass') ? 'pass' : 'fail';
        
        // Log results
        this.logger.info('Diagnostic results:', diagnostics);
        
        return diagnostics;
        
    } catch (error) {
        this.logger.error('Diagnostics failed:', error);
        diagnostics.status = 'error';
        diagnostics.error = error.message;
        return diagnostics;
    }
}

/**
 * Test UART communication
 */
async testUartCommunication() {
    try {
        const response = await this.uart.sendCommand('heartbeat()', true);
        return {
            status: response.includes('heartbeat(0)') ? 'pass' : 'fail',
            response: response
        };
    } catch (error) {
        return {
            status: 'fail',
            error: error.message
        };
    }
}

/**
 * Test meter system
 */
async testMeterSystem() {
    try {
        await this.uart.sendCommand('meter_reset()', false);
        const response = await this.uart.sendCommand('meter_read()', true);
        const reading = this.uart.parseMeterResponse(response);
        
        return {
            status: reading !== null ? 'pass' : 'fail',
            reading: reading
        };
    } catch (error) {
        return {
            status: 'fail',
            error: error.message
        };
    }
}

/**
 * Test RFID system
 */
async testRfidSystem() {
    try {
        const response = await this.uart.sendCommand(`rfid_get(${this.nozzleId})`, true);
        const rfidInfo = this.uart.parseRfidResponse(response);
        
        return {
            status: rfidInfo ? 'pass' : 'fail',
            rfidInfo: rfidInfo
        };
    } catch (error) {
        return {
            status: 'fail',
            error: error.message
        };
    }
}

/**
 * Test solenoid control
 */
async testSolenoidControl() {
    try {
        // Test close
        await this.setSolenoidState(false);
        // Brief delay
        await new Promise(resolve => setTimeout(resolve, 100));
        // Test open
        await this.setSolenoidState(true);
        // Brief delay
        await new Promise(resolve => setTimeout(resolve, 100));
        // Return to closed state
        await this.setSolenoidState(false);
        
        return {
            status: 'pass'
        };
    } catch (error) {
        return {
            status: 'fail',
            error: error.message
        };
    }
}



    async processRefillProgressState() {
        try {
            // Check for RFID alarm or nozzle communication timeout
            if ((Date.now() - this.lastNozzleHeartbeatTime > TIMEOUTS.NOZZLE_HEARTBEAT_TIMEOUT)) {
                this.logger.info('Nozzle communication lost');
                await this.setSolenoidState(false);
                this.retryCount = Math.floor(TIMEOUTS.RFID_RETRY_INTERVAL);
                this.startReqTimer();
                this.playSound('RFID_ALARM');
                this.setRfidLed(false);
                
                this.messageToApp = "Nozzle communication lost";
                this.logEvent('NOZZLE COMM ERROR');
                
                this.transition(
                    STATES.REFILL_INTERRUPT,
                    { 
                        lastMeterRead: this.meterReading.current,
                        reason: 'Nozzle communication timeout'
                    },
                    'Nozzle communication timeout'
                );
                return;
            }
    
            // Check for stop conditions (app request or timeout)
            if (this.stopRefill || this.checkAppCommTimeout()) {
                if (this.stopRefill) {
                    this.playSound('REFILL_END_BY_USER');
                    this.messageToApp = "Refill ended by user";
                    this.logEvent('REFILL END - USER STOP');
                } else {
                    this.playSound('REFILL_APP_COMM_TIMEOUT');
                    this.messageToApp = "App comm. timeout";
                    this.logEvent('APP COMM TIMEOUT');
                }
    
                this.refillEndReason = this.messageToApp;
                await this.setSolenoidState(false);
                await this.uart.sendCommand(`rfid_stop(${this.nozzleId})`, false);
                
                // Get final meter reading
                await this.uart.sendCommand('meter_read()', true);
                this.startReqTimer();
                this.retryCount = 2;
                
                this.transition(
                    STATES.REFILL_LAST_METER_READ,
                    { 
                        finalReading: this.meterReading.current,
                        reason: this.stopRefill ? 'User requested stop' : 'App timeout'
                    },
                    'Refill stopped by user or app timeout'
                );
                this.setRfidLed(false);
                return;
            }
    
            // Check tank capacity
            if (this.meterReading.current >= this.vehicle.VehicleTankCapacity) {
                await this.setSolenoidState(false);
                await this.uart.sendCommand(`rfid_stop(${this.nozzleId})`, false);
                
                this.messageToApp = "Max Tank Capacity Reached";
                this.refillEndReason = this.messageToApp;
                this.retryCount = 2;
                
                this.transition(
                    STATES.REFILL_LAST_METER_READ,
                    { 
                        finalReading: this.meterReading.current,
                        reason: 'Tank capacity reached'
                    },
                    'Vehicle tank capacity reached'
                );
                this.setRfidLed(false);
                return;
            }
    
            // Continue normal meter reading
            if (this.lastMeterResponse) {
                const isStable = this.isMeterReadingStable();
                if (isStable) {
                    // Request another meter read after stability confirmed
                    await this.uart.sendCommand('meter_read()', true);
                    this.startReqTimer();
                    this.retryCount = 5;
                }
            } else if (this.checkReqTimeout(TIMEOUTS.METER_READ_TIMEOUT)) {
                if (this.retriesFinished()) {
                    this.logEvent('REFILL END - METER READ TIMEOUT');
                    await this.setSolenoidState(false);
                    await this.uart.sendCommand('meter_read()', true);
                    await this.uart.sendCommand(`rfid_stop(${this.nozzleId})`, false);
                    
                    this.retryCount = 5;
                    this.transition(
                        STATES.REFILL_LAST_METER_READ,
                        {
                            finalReading: this.meterReading.current,
                            reason: 'Meter read timeout'
                        },
                        'Meter read timeout during refill'
                    );
                    this.setRfidLed(false);
                    this.messageToApp = "No response from meter";
                } else {
                    await this.uart.sendCommand('meter_read()', true);
                    this.startReqTimer();
                }
            }
        } catch (error) {
            this.logger.error('Error in refill progress state:', error);
            this.transition(
                STATES.REFILL_OP_ERROR,
                { error },
                `Error during refill: ${error.message}`
            );
        }
    }

    
    /**
         * Get current meter value with stability check
         * @returns {Promise<number|null>}
         */
    async getMeterValue() {
        try {
            const response = await this.uart.sendCommand('meter_read()', true);
            const value = this.uart.parseMeterResponse(response);
            
            if (value !== null) {
                const isStable = this.addMeterReading(value);
                this.logger.info(`Meter reading: ${value} (${isStable ? 'stable' : 'unstable'})`);
                return isStable ? value : null;
            }
            
            return null;
        } catch (error) {
            this.logger.error('Get meter value error:', error);
            return null;
        }
    }

    async getRfidTag() {
        try {
            const response = await this.uart.sendCommand(`rfid_get(${this.nozzleId})`, true);
            return this.uart.parseRfidResponse(response);
        } catch (error) {
            console.error('Get RFID tag error:', error);
            return null;
        }
    }

    async getRfidMatchStatus() {
        try {
            const response = await this.uart.sendCommand('rfid_match_status()', true);
            return response.includes('rfid_match()') ? 'match' : 'nomatch';
        } catch (error) {
            console.error('Get RFID match status error:', error);
            return null;
        }
    }

    async checkRfidAlarm() {
        try {
            const response = await this.uart.sendCommand('rfid_alarm_status()', true);
            return response.includes('rfid_alarm(1)');
        } catch (error) {
            console.error('Check RFID alarm error:', error);
            return false;
        }
    }

    async setSolenoidState(state) {
        try {
            await this.uart.sendCommand(`set_solenoid(${state ? '1' : '0'})`, false);
            this.solenoidState = state;
            return true;
        } catch (error) {
            console.error('Set solenoid state error:', error);
            return false;
        }
    }

    async startContinuousRfidRead() {
        try {
            this.logger.info(`Starting continuous RFID read for tag: ${this.vehicle.TagNumber}`);
            await this.uart.sendCommand(
                `rfid_get_cont(${this.nozzleId},${this.vehicle.TagNumber})`,
                false
            );
        } catch (error) {
            console.error('Failed to start continuous RFID read:', error);
            throw error;
        }
    }

    async stopRfidRead() {
        try {
            await this.uart.sendCommand(`rfid_stop(${this.nozzleId})`, false);
            this.logger.info('Stopped RFID reading');
        } catch (error) {
            console.error('Failed to stop RFID read:', error);
            throw error;
        }
    }

    checkNozzleConnection() {
        const nozzleTimeout = 10000; // 10 seconds without heartbeat is considered a timeout
        const nozzleDisconnected = Date.now() - this.lastNozzleHeartbeatTime > nozzleTimeout;
        
        if (nozzleDisconnected && this.currentState === STATES.REFILL_PROGRESS) {
            this.logger.info('Nozzle connection lost - no heartbeat received');
            this.transition(
                STATES.REFILL_INTERRUPT,
                { reason: 'Nozzle connection lost' },
                'No nozzle heartbeat received for 10 seconds'
            );
            return true;
        }
        return false;
    }

    setRfidLed(state) {
        this.rfidLedState = state;
        // Implement LED control if hardware supports it
        this.logger.info(`RFID LED: ${state ? 'ON' : 'OFF'}`);
    }

    // Database operations
    async addTransactionToDb() {
        try {
            return await this.db.addTransaction(this.currentTransaction);
        } catch (error) {
            console.error('Add transaction error:', error);
            return false;
        }
    }

    async updateTransactionLiters() {
        try {
            return await this.db.updateTransactionLiters(
                this.currentTransaction.id,
                this.currentTransaction.DispensedLiter
            );
        } catch (error) {
            console.error('Update transaction liters error:', error);
            return false;
        }
    }

    async addLitersDispensed(liters) {
        try {
            return await this.db.addLitersDispensed(liters);
        } catch (error) {
            console.error('Add liters dispensed error:', error);
            return false;
        }
    }

    async updateVehicleHours() {
        try {
            return true; // Implement vehicle hours update logic
        } catch (error) {
            console.error('Update vehicle hours error:', error);
            return false;
        }
    }

    async deleteTransaction() {
        try {
            return await this.db.deleteTransaction(this.currentTransaction.id);
        } catch (error) {
            console.error('Delete transaction error:', error);
            return false;
        }
    }

    async clearIncompleteTransaction() {
        try {
            return await this.db.clearIncompleteTransaction();
        } catch (error) {
            console.error('Clear incomplete transaction error:', error);
            return false;
        }
    }

    async checkZeroLiterDispense() {
        if (this.refillLiters === 0) {
            this.logEvent(`ZERO LITER DISPENSE: ${this.vehicle?.FleetNumber || 'Unknown Vehicle'}`);
            // Implement additional notification logic if needed
        }
    }

    // Utility methods
    checkAppCommTimeout() {
        return Date.now() - this.lastAppCommTime > TIMEOUTS.APP_COMM_TIMEOUT;
    }

    checkNozzleCommTimeout() {
        return Date.now() - this.lastHeartbeatTime > TIMEOUTS.NOZZLE_HEARTBEAT_TIMEOUT;
    }

    retriesFinished() {
        return this.retryCount <= 0;
    }

    startReqTimer() {
        this.requestStartTime = Date.now();
    }

    checkReqTimeout(timeout = TIMEOUTS.UART_RESPONSE_TIMEOUT) {
        return Date.now() - this.requestStartTime > timeout;
    }

    logEvent(message) {
        this.logger.info(`[EVENT] ${timeUtils.formatDateTime()}: ${message}`);
    }

    playSound(soundType) {
        this.logger.info(`Playing sound: ${soundType}`);
        // Implement sound playing logic if needed
    }

    // State info
    getStateInfo() {
        return {
            state: this.currentState,
            previousState: this.previousState,
            data: this.stateData,
            timestamp: this.stateTimestamp,
            currentTransaction: this.currentTransaction,
            vehicle: this.vehicle,
            refillLiters: this.refillLiters,
            messageToApp: this.messageToApp
        };
    }

    startHeartbeatMonitoring() {
        this.logger.info('Starting heartbeat monitoring system');
        
        // Clear any existing intervals
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
        }

        // Start heartbeat check interval
        this.heartbeatInterval = setInterval(async () => {
            try {
                const response = await this.uart.sendCommand('heartbeat()', true);
                if (response && response.includes('heartbeat(0)')) {
                    this.lastHeartbeatTime = Date.now();
                    this.lastHeartbeatCheckTime = Date.now();
                    this.emit('heartbeat', { status: 'ok', timestamp: Date.now() });
                } else {
                    this.logger.warn('Invalid heartbeat response:', response);
                    this.emit('heartbeat', { status: 'invalid', timestamp: Date.now() });
                }
            } catch (error) {
                this.logger.error('Heartbeat error:', error);
                this.emit('heartbeat', { status: 'error', timestamp: Date.now(), error });
            }
        }, 5000); // Check every 5 seconds

        // Start system monitoring interval
        this.monitoringInterval = setInterval(() => {
            this.monitorSystemHealth();
        }, 1000); // Monitor every second

        // Set initial timestamps
        this.lastHeartbeatTime = Date.now();
        this.lastHeartbeatCheckTime = Date.now();
        this.lastMonitoringCheck = Date.now();

        this.logger.info('Heartbeat and monitoring systems initialized');
    }

     /**
     * Monitor overall system health
     */
     async monitorSystemHealth() {
        try {
            const now = Date.now();
            const healthStatus = {
                timestamp: now,
                heartbeat: {
                    status: 'ok',
                    lastBeat: this.lastHeartbeatTime,
                    timeSinceLastBeat: now - this.lastHeartbeatTime
                },
                nozzle: {
                    status: 'ok',
                    lastComm: this.lastNozzleHeartbeatTime,
                    timeSinceLastComm: now - this.lastNozzleHeartbeatTime
                },
                app: {
                    status: 'ok',
                    lastComm: this.lastAppCommTime,
                    timeSinceLastComm: now - this.lastAppCommTime
                },
                meter: {
                    status: 'ok',
                    current: this.meterReading.current,
                    lastStable: this.meterReading.lastStable,
                    lastUpdate: this.meterReading.stabilityTimestamp
                }
            };

            // Check heartbeat health
            if (now - this.lastHeartbeatTime > TIMEOUTS.NOZZLE_HEARTBEAT_TIMEOUT) {
                healthStatus.heartbeat.status = 'error';
                this.handleHeartbeatTimeout();
            }

            // Check nozzle communication
            if (this.currentState !== STATES.REFILL_OP_IDLE && 
                now - this.lastNozzleHeartbeatTime > TIMEOUTS.NOZZLE_HEARTBEAT_TIMEOUT) {
                healthStatus.nozzle.status = 'error';
                this.handleNozzleTimeout();
            }

            // Check app communication
            if (this.currentState !== STATES.REFILL_OP_IDLE && 
                this.checkAppCommTimeout()) {
                healthStatus.app.status = 'error';
                this.handleAppTimeout();
            }

            // Check meter reading health
            if (this.currentState === STATES.REFILL_PROGRESS && 
                !this.lastMeterResponse) {
                healthStatus.meter.status = 'warning';
            }

            // Emit health status
            this.emit('healthStatus', healthStatus);

            // Log critical issues
            if (Object.values(healthStatus).some(component => component.status === 'error')) {
                this.logger.error('Critical system health issues detected:', healthStatus);
            }

        } catch (error) {
            this.logger.error('Error in system health monitoring:', error);
            this.emit('healthStatus', { 
                timestamp: Date.now(), 
                status: 'error',
                error: error.message 
            });
        }
    }

    /**
     * Handle heartbeat timeout
     */
    handleHeartbeatTimeout() {
        this.logger.error('Heartbeat timeout detected');
        
        if (this.currentState !== STATES.REFILL_OP_ERROR) {
            this.transition(
                STATES.REFILL_OP_ERROR,
                { reason: 'Heartbeat timeout' },
                'System heartbeat timeout detected'
            );
        }
    }

    /**
     * Handle nozzle communication timeout
     */
    async handleNozzleTimeout() {
        this.logger.error('Nozzle communication timeout');
        
        if (this.currentState === STATES.REFILL_PROGRESS) {
            await this.setSolenoidState(false);
            this.playSound('NOZZLE_TIMEOUT_ALARM');
            
            this.transition(
                STATES.REFILL_INTERRUPT,
                { 
                    reason: 'Nozzle timeout',
                    lastReading: this.meterReading.current
                },
                'Nozzle communication timeout during refill'
            );
        }
    }

        /**
     * Handle app communication timeout
     */
        async handleAppTimeout() {
            this.logger.error('App communication timeout');
            
            if (this.currentState === STATES.REFILL_PROGRESS) {
                this.messageToApp = "App communication timeout";
                this.refillEndReason = this.messageToApp;
                
                await this.setSolenoidState(false);
                await this.uart.sendCommand(`rfid_stop(${this.nozzleId})`, false);
                
                this.transition(
                    STATES.REFILL_LAST_METER_READ,
                    { reason: 'App timeout' },
                    'App communication timeout during refill'
                );
            }
        }


    /**
         * Check app communication timeout
         */
    checkAppCommTimeout() {
        return Date.now() - this.lastAppCommTime > TIMEOUTS.APP_COMM_TIMEOUT;
    }

    /**
     * Update app communication timestamp
     */
    updateAppCommTime() {
        this.lastAppCommTime = Date.now();
    }

    /**
     * Cleanup monitoring systems
     */
    cleanup() {
        this.logger.info('Cleaning up monitoring systems');
        
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
        }

        // Clear any pending timeouts
        if (this.stabilityTimeout) {
            clearTimeout(this.stabilityTimeout);
        }

        this.logger.info('Monitoring systems cleaned up');
    }

    /**
     * Get complete system status
     */
    getSystemStatus() {
        return {
            state: {
                current: this.currentState,
                previous: this.previousState,
                timestamp: this.stateTimestamp
            },
            meter: {
                current: this.meterReading.current,
                lastStable: this.meterReading.lastStable,
                lastSaved: this.meterReading.lastSaved
            },
            communication: {
                lastHeartbeat: this.lastHeartbeatTime,
                lastNozzleComm: this.lastNozzleHeartbeatTime,
                lastAppComm: this.lastAppCommTime
            },
            operation: {
                vehicle: this.vehicle,
                transaction: this.currentTransaction,
                flags: {
                    stopRefill: this.stopRefill,
                    appInformed: this.appInformed,
                    rfidInContact: this.rfidInContact
                }
            },
            device: {
                nozzleId: this.nozzleId,
                solenoidState: this.solenoidState,
                rfidLedState: this.rfidLedState
            }
        };
    }

    /**
     * Process idle state with improved monitoring
     */
    async processIdleState() {
        try {
            // Only transition to error if we've had no heartbeat for double the timeout
            if (Date.now() - this.lastHeartbeatTime > TIMEOUTS.NOZZLE_HEARTBEAT_TIMEOUT * 2) {
                this.logger.error('Extended heartbeat timeout in idle state');
                this.transition(
                    STATES.REFILL_OP_ERROR,
                    { reason: 'Extended heartbeat timeout' },
                    'No heartbeat received for extended period'
                );
                return;
            }

            // Periodic system health check in idle
            if (!this.lastHealthCheckTime || 
                Date.now() - this.lastHealthCheckTime > 30000) {
                try {
                    const response = await this.uart.sendCommand('heartbeat()', true);
                    if (response.includes('heartbeat(0)')) {
                        this.lastHeartbeatTime = Date.now();
                        this.lastHealthCheckTime = Date.now();
                        this.logger.debug('Idle state health check passed');
                    }
                } catch (error) {
                    this.logger.warn('Idle state health check failed:', error);
                }
            }
        } catch (error) {
            this.logger.error('Error in idle state processing:', error);
        }
    }

    async handleUartResponse(data) {
        this.logger.info('\n=== Processing UART Response ===');
        this.logger.info('Received:', data);
    
        // Store the raw response
        this.lastUartResponse = data;
    
        // Handle meter readings first (high priority)
        if (data.includes('meter_read')) {
            const meterValue = this.uart.parseMeterResponse(data);
            if (meterValue !== null) {
                const isStable = this.addMeterReading(meterValue);
                
                if (this.currentTransaction) {
                    this.currentTransaction.dispensedLiter = this.meterReading.current.toString();
                    
                    // Check for save threshold
                    if (this.meterReading.current - this.meterReading.lastSaved >= DEVICE_CONFIG.LITER_SAVE_INTERVAL) {
                        await this.updateTransactionLiters();
                        this.meterReading.lastSaved = this.meterReading.current;
                    }
                }
    
                this.logger.info(`Meter reading updated: ${meterValue} (${isStable ? 'stable' : 'unstable'})`);
                this.emit('meterUpdate', {
                    value: meterValue,
                    isStable,
                    timestamp: Date.now()
                });
            }
            return;
        }
    
        // Handle heartbeat
        if (data.includes('heartbeat')) {
            this.lastHeartbeatTime = Date.now();
            return;
        }
    
        // Handle nozzle heartbeat
        if (data.includes('nhb')) {
            const match = data.match(/nhb\((\d+),(\d+)\)/);
            if (match && match[1] === this.nozzleId) {
                this.lastNozzleHeartbeatTime = Date.now();
                this.logger.info('Nozzle heartbeat received, sending a response');
                try {
                    await this.uart.sendCommand(`cbhb(${this.nozzleId})`, false);
                    this.logger.info('Control board heartbeat sent');
                } catch (error) {
                    this.logger.error('Failed to send CBHB:', error);
                    throw error;
                }
            }
            return;
        }
    
        // Handle RFID match
        if (data.includes('rfid_match')) {
            const match = data.match(/rfid_match\((\d+),(\d+)\)/);
            if (match && match[1] === this.nozzleId) {
                this.logger.info('RFID match confirmed');
                this.lastRfidMatchTime = Date.now();
                this.lastNozzleHeartbeatTime = Date.now();
                this.logger.debug('Nozzle heartbeat timer reset');
                this.rfidInContact = true;
                
                this.emit('rfidMatch', {
                    nozzleId: match[1],
                    timestamp: this.lastRfidMatchTime
                });
            }
            return;
        }
    
        // Handle RFID alarm
        if (data.includes('rfid_alarm')) {
            const match = data.match(/rfid_alarm\((\d+)\)/);
            if (match && match[1] === this.nozzleId) {
                this.logger.info('RFID alarm received - tag contact lost');
                this.rfidInContact = false;
                this.rfidAlarmReceived = true;
                this.lastNozzleHeartbeatTime = Date.now();
                this.logger.debug('Nozzle heartbeat timer reset');
                
                if (this.currentState === STATES.REFILL_PROGRESS) {
                    const currentMeterReading = this.meterReading.current;
                    this.transition(
                        STATES.REFILL_INTERRUPT,
                        { 
                            reason: 'RFID contact lost',
                            lastReading: currentMeterReading
                        },
                        'RFID alarm received - tag contact lost'
                    );
                }
                
                this.emit('rfidAlarm', {
                    nozzleId: match[1],
                    lastReading: this.meterReading.current,
                    timestamp: Date.now()
                });
            }
            return;
        }
    
        // Handle RFID response
        if (data.includes('rfid_get')) {
            const rfidInfo = this.uart.parseRfidResponse(data);
            this.lastNozzleHeartbeatTime = Date.now();
            this.logger.debug('Nozzle heartbeat timer reset');
            
            if (rfidInfo) {
                this.logger.info('Parsed RFID info:', rfidInfo);
                
                if (this.currentState === STATES.REFILL_GET_FIRST_RFID) {
                    this.processRfidResponse(rfidInfo).catch(error => {
                        this.logger.error('Error processing RFID response:', error);
                        this.transition(
                            STATES.REFILL_OP_ERROR,
                            { error },
                            'Failed to process RFID response'
                        );
                    });
                }
                
                this.emit('rfidRead', {
                    ...rfidInfo,
                    timestamp: Date.now()
                });
            }
            return;
        }
    }
    

    async processRfidResponse(rfidInfo) {
        this.logger.info('\n=== Processing RFID Tag ===');
        
        // Handle empty tag
        if (rfidInfo.rfidTag === '-') {
            this.logger.info('No tag detected, continuing to scan...');
            return;
        }

        this.logger.info(`Validating RFID tag: ${rfidInfo.rfidTag}`);
        
        // Check against fleet data
        const vehicle = this.fleetData.find(v => v.TagNumber === rfidInfo.rfidTag);
        
        if (vehicle) {
            this.logger.info('Vehicle found in fleet database:', {
                fleetNumber: vehicle.FleetNumber,
                tagNumber: vehicle.TagNumber,
                tankCapacity: vehicle.VehicleTankCapacity
            });

            this.vehicle = vehicle;
            this.currentTransaction = {
                ...this.currentTransaction,
                tagNumber: rfidInfo.rfidTag,
                fleetNumber: vehicle.FleetNumber,
                tankCapacity: vehicle.VehicleTankCapacity
            };

            this.transition(
                STATES.REFILL_WAIT_FOR_DRF_SUBMIT,
                { vehicle, rfidInfo },
                'Valid RFID tag detected and validated against fleet database'
            );
        } else {
            this.logger.info('RFID tag not found in fleet database');
            this.transition(
                STATES.REFILL_OP_IDLE,
                { rfidInfo },
                'RFID tag validation failed - tag not found in fleet database'
            );
        }
    }


    /*++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++*/
    /**
     * Add a new meter reading and check stability
     * @param {number} reading
     * @returns {boolean} - true if reading is stable
     */
    addMeterReading(reading) {
        if (this.meterReading.readings.length === 0) {
            this.meterReading.stabilityTimestamp = Date.now();
        }

        this.meterReading.readings.push(reading);
        this.meterReading.current = reading;

        // Keep only recent readings
        if (this.meterReading.readings.length > this.meterReading.stabilityThreshold * 2) {
            this.meterReading.readings.shift();
        }

        const isStable = this.isMeterReadingStable();
        if (isStable) {
            this.meterReading.lastStable = reading;
        }

        return isStable;
    }

    isMeterReadingStable() {
        if (this.meterReading.readings.length < this.meterReading.stabilityThreshold) {
            return false;
        }
    
        const lastReadings = this.meterReading.readings.slice(-this.meterReading.stabilityThreshold);
        const allEqual = lastReadings.every(reading => reading === lastReadings[0]);
        
        if (allEqual) {
            const timeSinceFirst = Date.now() - this.meterReading.stabilityTimestamp;
            return timeSinceFirst >= this.meterReading.stabilityTimeoutMs;
        }
    
        return false;
    }
}

module.exports = FuelStateMachine;