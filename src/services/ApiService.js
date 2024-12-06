const axios = require('axios');
const { API_CONFIG } = require('../config/constants');

class ApiService {
    constructor(config = API_CONFIG) {
        this.config = config;
        this.token = null;
        this.tokenExpiry = null;
        this.axiosInstance = axios.create({
            baseURL: config.BASE_URL,
            timeout: 10000
        });
    }

    async initialize() {
        try {
            await this.login();
            return true;
        } catch (error) {
            console.error('Failed to initialize API service:', error);
            throw error;
        }
    }

    async login() {
        try {
            const response = await this.axiosInstance.post('/login', {
                UserName: this.config.CREDENTIALS.USERNAME,
                Password: this.config.CREDENTIALS.PASSWORD
            });

            if (response.data.Type === 'S' && response.data.ResponseModel) {
                this.token = response.data.ResponseModel;
                // Set token expiry to 4.5 minutes (allowing buffer before actual 5-minute expiry)
                this.tokenExpiry = Date.now() + (4.5 * 60 * 1000);
                this.axiosInstance.defaults.headers.common['Token'] = this.token;
                return true;
            } else {
                throw new Error('Login failed: Invalid response');
            }
        } catch (error) {
            console.error('Login failed:', error);
            throw error;
        }
    }

    async ensureValidToken() {
        if (!this.token || Date.now() >= this.tokenExpiry) {
            await this.login();
        }
    }

    async getAvailableTags(tankId = this.config.TANK_ID) {
        try {
            await this.ensureValidToken();

            const response = await this.axiosInstance.post('/GetAvailableTagsByTankId', {
                HardwareTankId: tankId
            });

            if (response.data.Type === 'S' && response.data.ResponseModel) {
                return response.data.ResponseModel.AvailableTags;
            } else {
                throw new Error('Failed to get available tags: Invalid response');
            }
        } catch (error) {
            console.error('Failed to get available tags:', error);
            throw error;
        }
    }

    async validateTag(tagNumber, tankId = this.config.TANK_ID) {
        try {
            const availableTags = await this.getAvailableTags(tankId);
            return availableTags.find(tag => tag.TagNumber === tagNumber);
        } catch (error) {
            console.error('Tag validation failed:', error);
            throw error;
        }
    }

    // Additional API methods can be added here as needed
    async updateVehicleHours(fleetNumber, hours) {
        // TODO: Implement when API endpoint is available
        throw new Error('Not implemented');
    }

    async reportRefill(refillData) {
        // TODO: Implement when API endpoint is available
        throw new Error('Not implemented');
    }
}

module.exports = ApiService;