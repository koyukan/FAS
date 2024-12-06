// State definitions
const STATES = {
    REFILL_OP_IDLE: 'refill_op_idle',
    REFILL_OP_ERROR: 'refill_op_error',
    REFILL_OP_START: 'refill_op_start',
    REFILL_GET_FIRST_RFID: 'refill_get_first_rfid',
    REFILL_WAIT_FOR_DRF_SUBMIT: 'refill_wait_for_drf_submit',
    REFILL_READ_FIRST_METER: 'refill_read_first_meter',
    REFILL_WAIT_FIRST_RFID_MATCH: 'refill_wait_first_rfid_match',
    REFILL_PROGRESS: 'refill_progress',
    REFILL_INTERRUPT: 'refill_interrupt',
    REFILL_LAST_METER_READ: 'refill_last_meter_read',
    REFILL_WAIT_METER_STABILITY: 'refill_wait_meter_stability',
    REFILL_WAIT_APP_INFORM: 'refill_wait_app_inform',
    REFILL_FORCE_STOP: 'refill_force_stop'
};

// Timeouts and intervals (in milliseconds)
const TIMEOUTS = {
    RFID_RETRY_INTERVAL: 5000,      // 5 seconds
    RFID_MAX_DURATION: 180000,      // 3 minutes
    METER_READ_TIMEOUT: 5000,       // 5 seconds
    METER_STABILITY_TIMEOUT: 5000,  // 5 seconds
    DRF_SUBMIT_TIMEOUT: 120000,     // 2 minutes
    NOZZLE_HEARTBEAT_TIMEOUT: 40000,// 10 seconds
    UART_RESPONSE_TIMEOUT: 5000,    // 5 seconds
    APP_COMM_TIMEOUT: 600000,        // 30 seconds
    STATE_PROCESSING_INTERVAL: 1000,  // 1 second
    APP_INFORM_TIMEOUT: 10000       // 1 minute
};

// UART Configuration
const UART_CONFIG = {
    DEFAULT_PATH: '/dev/ttyUSB0',
    BAUD_RATE: 460800,
    DATA_BITS: 8,
    STOP_BITS: 1,
    PARITY: 'none',
    DELIMITER: '\n'
};

// API Configuration
const API_CONFIG = {
    BASE_URL: 'https://devcoreapi.minetec.co.za/api',
    CREDENTIALS: {
        USERNAME: "CanyonsevicesuserLive",
        PASSWORD: "0FB9F499-3699-4F0C-AD69-A99**f8F5c"
    },
    TANK_ID: 39
};

// Device Configuration
const DEVICE_CONFIG = {
    DEFAULT_NOZZLE_ID: '0076',
    LITER_SAVE_INTERVAL: 1.0,  // Save every 1 liter
    MAX_RETRIES: 100
};

module.exports = {
    STATES,
    TIMEOUTS,
    UART_CONFIG,
    API_CONFIG,
    DEVICE_CONFIG
};