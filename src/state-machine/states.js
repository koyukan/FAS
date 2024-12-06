// State definitions with metadata and validation rules
const STATE_DEFINITIONS = {
    REFILL_OP_IDLE: {
        name: 'refill_op_idle',
        description: 'System in standby',
        allowedTransitions: ['REFILL_OP_ERROR', 'REFILL_OP_START'],
        timeouts: {
            heartbeat: 10000 // 10 seconds
        },
        validations: {
            canTransition: (currentState, targetState, data) => {
                // Can always transition to error
                if (targetState === 'REFILL_OP_ERROR') return true;
                // Can only start if system is healthy
                if (targetState === 'REFILL_OP_START') {
                    return data.lastHeartbeat && (Date.now() - data.lastHeartbeat < 10000);
                }
                return false;
            }
        }
    },

    REFILL_OP_ERROR: {
        name: 'refill_op_error',
        description: 'System encountered an error',
        allowedTransitions: ['REFILL_OP_IDLE'],
        timeouts: {
            recovery: 30000 // 30 seconds before auto-recovery attempt
        },
        validations: {
            canTransition: (currentState, targetState, data) => {
                // Can only return to idle after timeout
                return targetState === 'REFILL_OP_IDLE' && 
                       Date.now() - data.errorTimestamp > 30000;
            }
        }
    },

    REFILL_OP_START: {
        name: 'refill_op_start',
        description: 'Initialize refill operation',
        allowedTransitions: ['REFILL_GET_FIRST_RFID', 'REFILL_OP_ERROR'],
        timeouts: {
            initialization: 5000 // 5 seconds to initialize
        },
        validations: {
            canTransition: () => true // Can always transition from start
        }
    },

    REFILL_GET_FIRST_RFID: {
        name: 'refill_get_first_rfid',
        description: 'Waiting for initial RFID tag read',
        allowedTransitions: ['REFILL_WAIT_FOR_DRF_SUBMIT', 'REFILL_OP_IDLE', 'REFILL_OP_ERROR'],
        timeouts: {
            rfidRead: 180000, // 3 minutes total timeout
            retryInterval: 5000 // 5 seconds between retries
        },
        validations: {
            canTransition: (currentState, targetState, data) => {
                if (targetState === 'REFILL_WAIT_FOR_DRF_SUBMIT') {
                    return data.rfidTag && data.vehicle;
                }
                return true; // Can timeout to IDLE or error
            }
        }
    },

    REFILL_WAIT_FOR_DRF_SUBMIT: {
        name: 'refill_wait_for_drf_submit',
        description: 'Waiting for DRF submission',
        allowedTransitions: ['REFILL_READ_FIRST_METER', 'REFILL_OP_IDLE', 'REFILL_OP_ERROR'],
        timeouts: {
            drfSubmit: 120000 // 2 minutes to submit DRF
        },
        validations: {
            canTransition: (currentState, targetState, data) => {
                if (targetState === 'REFILL_READ_FIRST_METER') {
                    return data.kilometers && data.kilometers <= 1000;
                }
                return true; // Can timeout to IDLE or error
            }
        }
    },

    REFILL_READ_FIRST_METER: {
        name: 'refill_read_first_meter',
        description: 'Reading initial meter value',
        allowedTransitions: ['REFILL_WAIT_FIRST_RFID_MATCH', 'REFILL_OP_IDLE', 'REFILL_OP_ERROR'],
        timeouts: {
            meterRead: 5000 // 5 seconds for meter read
        },
        validations: {
            canTransition: (currentState, targetState, data) => {
                if (targetState === 'REFILL_WAIT_FIRST_RFID_MATCH') {
                    return data.meterActive === true;
                }
                return true;
            }
        }
    },

    REFILL_WAIT_FIRST_RFID_MATCH: {
        name: 'refill_wait_first_rfid_match',
        description: 'Waiting for RFID match confirmation',
        allowedTransitions: ['REFILL_PROGRESS', 'REFILL_WAIT_APP_INFORM', 'REFILL_OP_IDLE', 'REFILL_OP_ERROR'],
        timeouts: {
            rfidMatch: 10000 // 10 seconds to get match
        },
        validations: {
            canTransition: (currentState, targetState, data) => {
                if (targetState === 'REFILL_PROGRESS') {
                    return data.rfidMatch === true && data.dbTransaction;
                }
                return true;
            }
        }
    },

    REFILL_PROGRESS: {
        name: 'refill_progress',
        description: 'Refill in progress',
        allowedTransitions: ['REFILL_INTERRUPT', 'REFILL_LAST_METER_READ', 'REFILL_OP_ERROR'],
        timeouts: {
            meterRead: 5000, // 5 seconds between meter reads
            appComm: 30000   // 30 seconds app communication timeout
        },
        validations: {
            canTransition: (currentState, targetState, data) => {
                if (targetState === 'REFILL_LAST_METER_READ') {
                    return data.stopRefill || 
                           data.refillLiters >= data.tankCapacity ||
                           Date.now() - data.lastAppComm > 30000;
                }
                return true;
            }
        }
    },

    REFILL_INTERRUPT: {
        name: 'refill_interrupt',
        description: 'Refill interrupted',
        allowedTransitions: ['REFILL_PROGRESS', 'REFILL_LAST_METER_READ', 'REFILL_OP_ERROR'],
        timeouts: {
            rfidRetry: 5000,  // 5 seconds between retries
            maxRetries: 30000 // 30 seconds max retry time
        },
        validations: {
            canTransition: (currentState, targetState, data) => {
                if (targetState === 'REFILL_PROGRESS') {
                    return data.rfidRecovered === true;
                }
                return true;
            }
        }
    },

    REFILL_LAST_METER_READ: {
        name: 'refill_last_meter_read',
        description: 'Reading final meter value',
        allowedTransitions: ['REFILL_WAIT_METER_STABILITY', 'REFILL_WAIT_APP_INFORM', 'REFILL_OP_ERROR'],
        timeouts: {
            meterRead: 5000 // 5 seconds for meter read
        },
        validations: {
            canTransition: (currentState, targetState, data) => {
                if (targetState === 'REFILL_WAIT_APP_INFORM') {
                    return data.meterStable === true;
                }
                return true;
            }
        }
    },

    REFILL_WAIT_METER_STABILITY: {
        name: 'refill_wait_meter_stability',
        description: 'Waiting for meter reading to stabilize',
        allowedTransitions: ['REFILL_LAST_METER_READ', 'REFILL_OP_ERROR'],
        timeouts: {
            stability: 5000 // 5 seconds stability check
        },
        validations: {
            canTransition: (currentState, targetState, data) => {
                return Date.now() - data.stabilityStartTime >= 5000;
            }
        }
    },

    REFILL_WAIT_APP_INFORM: {
        name: 'refill_wait_app_inform',
        description: 'Waiting for app acknowledgment',
        allowedTransitions: ['REFILL_OP_IDLE', 'REFILL_OP_ERROR'],
        timeouts: {
            appInform: 2000 // 2 seconds to inform app
        },
        validations: {
            canTransition: (currentState, targetState, data) => {
                return targetState === 'REFILL_OP_IDLE' && 
                       (data.appInformed || Date.now() - data.informStartTime >= 2000);
            }
        }
    },

    REFILL_FORCE_STOP: {
        name: 'refill_force_stop',
        description: 'Force stop requested',
        allowedTransitions: ['REFILL_LAST_METER_READ', 'REFILL_WAIT_APP_INFORM', 'REFILL_OP_ERROR'],
        timeouts: {},
        validations: {
            canTransition: (currentState, targetState, data) => {
                if (targetState === 'REFILL_WAIT_APP_INFORM') {
                    return data.refillLiters === 0;
                }
                return true;
            }
        }
    }
};

// Function to validate state transition
function validateStateTransition(currentState, targetState, data = {}) {
    const stateDefinition = STATE_DEFINITIONS[currentState];
    if (!stateDefinition) {
        throw new Error(`Invalid current state: ${currentState}`);
    }

    // Check if transition is allowed
    if (!stateDefinition.allowedTransitions.includes(targetState)) {
        return {
            valid: false,
            reason: `Transition from ${currentState} to ${targetState} not allowed`
        };
    }

    // Run state-specific validation
    const validationResult = stateDefinition.validations.canTransition(currentState, targetState, data);
    if (!validationResult) {
        return {
            valid: false,
            reason: `Validation failed for transition from ${currentState} to ${targetState}`
        };
    }

    return { valid: true };
}

// Get timeout for current state and timeout type
function getStateTimeout(state, timeoutType) {
    const stateDefinition = STATE_DEFINITIONS[state];
    if (!stateDefinition) {
        throw new Error(`Invalid state: ${state}`);
    }
    return stateDefinition.timeouts[timeoutType] || null;
}

// Get state metadata
function getStateMetadata(state) {
    const stateDefinition = STATE_DEFINITIONS[state];
    if (!stateDefinition) {
        throw new Error(`Invalid state: ${state}`);
    }
    return {
        name: stateDefinition.name,
        description: stateDefinition.description,
        allowedTransitions: stateDefinition.allowedTransitions,
        timeouts: stateDefinition.timeouts
    };
}

module.exports = {
    STATE_DEFINITIONS,
    validateStateTransition,
    getStateTimeout,
    getStateMetadata
};