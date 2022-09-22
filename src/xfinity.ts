import puppeteer from 'puppeteer-core';

import { readCookies, writeCookies } from './cookies.js';
import { fetchCode, imapConfig } from './imap.js';
import logger from './logger.js';
import Password from './password.js';
import { generateUserAgent, userAgent } from './userAgent.js';

const JSON_URL = 'https://customer.xfinity.com/apis/csp/account/me/services/internet/usage?filter=internet';
const LOGIN_URL = 'https://customer.xfinity.com';
const SECURITY_CHECK_TITLE = 'Security Check';
const PASSWORD_RESET_TITLE = 'Please reset your Xfinity password';

export interface xfinityConfig {
    username: string;
    password: string;
    interval: number;
    pageTimeout: number;
}

interface xfinityUsageMonth {
    policyName: string;
    startDate: string;
    endDate: string;
    homeUsage: number;
    wifiUsage: number;
    totalUsage: number;
    allowableUsage: number;
    unitOfMeasure: string;
    displayUsage: boolean;
    devices: Array<{ id: string; usage: number }>;
    additionalBlocksUsed: number;
    additionalCostPerBlock: number;
    additionalUnitsPerBlock: number;
    additionalIncluded: number;
    additionalUsed: number;
    additionalPercentUsed: number;
    additionalRemaining: number;
    billableOverage: number;
    overageCharges: number;
    overageUsed: number;
    currentCreditAmount: number;
    maxCreditAmount: number;
    policy: string;
}

export interface xfinityUsage {
    courtesyUsed: number;
    courtesyRemaining: number;
    courtesyAllowed: number;
    inPaidOverage: boolean;
    displayUsage: boolean;
    usageMonths: Array<xfinityUsageMonth>;
    error?: string;
    /* eslint-disable-next-line camelcase */
    logged_in_within_limit?: boolean;
}

export class Xfinity {
    #browser?: puppeteer.Browser;
    #page?: puppeteer.Page;
    #password: string;
    #username: string;
    #pageTimeout: number;
    #userAgent: userAgent;
    #imapConfig?: imapConfig;
    #Password?: Password;

    constructor({ username, password, pageTimeout }: xfinityConfig, imapConfig?: imapConfig) {
        this.#username = username;
        this.#password = password;
        this.#pageTimeout = pageTimeout * 1000;
        this.#imapConfig = imapConfig;
        if (imapConfig) {
            this.#Password = new Password(this.#password);
        }
        this.#userAgent = generateUserAgent();
    }

    private getPassword(): string {
        if (this.#imapConfig && this.#Password) {
            return this.#Password.getPassword();
        }

        return this.#password;
    }

    async fetch(): Promise<xfinityUsage> {
        logger.verbose('Fetching Data');
        try {
            const data = await this.retrieveDataUsage();
            logger.verbose('Data retrieved');
            return data;
        } finally {
            await this.#page?.close();
            await this.#browser?.close();
        }
    }

    private async retrieveDataUsage(): Promise<xfinityUsage> {
        let data: xfinityUsage;
        let retries = 3;

        do {
            if (retries === 0) {
                throw new Error('Unable to login');
            }
            if (retries !== 3) {
                logger.debug('Not logged in');
            }
            await this.authenticate();
            retries--;
            data = await this.getJson();
        } while (!data || data.error === 'unauthenticated' || data.logged_in_within_limit === false);

        await this.saveCookies();

        return data;
    }

    private async getJson(): Promise<xfinityUsage> {
        logger.debug(`Loading Usage ${JSON_URL}`);
        const page = await this.getPage();

        await page.goto(JSON_URL, { waitUntil: ['networkidle0', 'load', 'domcontentloaded'] });
        const element = await page.waitForSelector('pre');
        const property = await element?.getProperty('innerHTML');
        const value = await property?.jsonValue();

        let jsonData;
        try {
            jsonData = JSON.parse(value ?? '');
        } catch (e) {
            logger.error(`Bad JSON: ${value}`);
        }

        return jsonData;
    }

    private async authenticate() {
        logger.debug(`Loading (${LOGIN_URL})`);
        const page = await this.getPage();

        const response = await page.goto(LOGIN_URL, { waitUntil: ['networkidle0', 'load', 'domcontentloaded'] });

        // If no redirects should mean we're already logged in
        const redirects = response?.request().redirectChain().length;
        logger.debug(`Login redirects: ${redirects}`);
        if (redirects === 0) {
            return;
        }

        await this.login();
        const pageTitle = await page.title();
        logger.debug(`Page Title: ${pageTitle}`);

        if (pageTitle === PASSWORD_RESET_TITLE) {
            await this.resetPassword();
        } else if (pageTitle === SECURITY_CHECK_TITLE) {
            await this.bypassSecurityCheck();
        }
    }

    private async login() {
        logger.debug('Logging in');
        const page = await this.getPage();
        await this.waitForSelectorVisible('#user', '#sign_in');
        await page.type('#user', this.#username);
        await Promise.all([page.click('#sign_in'), page.waitForNavigation({ waitUntil: 'networkidle0' })]);
        await this.waitForSelectorVisible('#passwd');
        await page.type('#passwd', this.getPassword());
        return Promise.all([
            page.click('#sign_in'),
            page.waitForNavigation({ waitUntil: ['networkidle0', 'load', 'domcontentloaded'] }),
        ]);
    }

    private async resetPassword() {
        logger.info('Attempting to reset password');
        if (this.#imapConfig === undefined) {
            throw new Error('No imap configured');
        }
        if (!this.#Password) {
            return;
        }
        const page = await this.getPage();
        await this.waitForSelectorVisible('.submit');
        await Promise.all([page.click('.submit'), page.waitForNavigation({ waitUntil: 'networkidle0' })]);

        await this.waitForSelectorVisible('#submitButton');
        await Promise.all([page.click('#submitButton'), page.waitForNavigation({ waitUntil: 'networkidle0' })]);

        // Wait for the page to load
        await this.waitForSelectorVisible('#resetCodeEntered');

        // Get Code
        const code = await fetchCode(this.#imapConfig).catch((e) => {
            logger.error(e);
        });
        if (!code) return;
        logger.debug(`CODE: ${code}`);

        // Enter Code
        await this.waitForSelectorVisible('#resetCodeEntered', '#submitButton');
        await page.type('#resetCodeEntered', code);
        await Promise.all([page.click('#submitButton'), page.waitForNavigation({ waitUntil: 'networkidle0' })]);

        await this.waitForSelectorVisible('#password', '#passwordRetype', '#submitButton');
        const password = this.#Password.generatePassword();
        await page.type('#password', password);
        await page.type('#passwordRetype', password);
        await Promise.all([page.click('#submitButton'), page.waitForNavigation({ waitUntil: 'networkidle0' })]);

        // Check to see if password was accepted
        await this.waitForSelectorVisible('h2');
        const element = await page.$('h2 span');
        const elementClasses = await element?.getProperty('className');
        const classString = await elementClasses?.jsonValue();

        if (!classString?.includes('verified-large')) {
            throw new Error(
                'Unable to verify the password reset. The confirmation page was not found. The password suffix value will not be incremented.',
            );
        }

        await this.#Password.savePassword();
        logger.info('Password reset');
    }

    private async bypassSecurityCheck() {
        logger.info('Clicking "Ask me later" for security check');
        const page = await this.getPage();
        this.waitForSelectorVisible('.cancel');
        await Promise.all([page.click('.cancel'), page.waitForNavigation({ waitUntil: 'networkidle0' })]);
    }

    private async getBrowser() {
        if (this.#browser?.isConnected()) return this.#browser;

        this.#browser = await puppeteer.launch({
            executablePath: '/usr/bin/chromium',
            pipe: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });

        return this.#browser;
    }

    private async getPage() {
        if (this.#page?.isClosed() !== false) {
            const browser = await this.getBrowser();
            const page = await browser.newPage();

            await page.setCookie(...readCookies());
            const { userAgent, width, height } = this.#userAgent;
            await page.setUserAgent(userAgent);
            await page.setViewport({ width, height });
            page.setDefaultNavigationTimeout(this.#pageTimeout);

            this.#page = page;
            await page.setRequestInterception(true);
            page.on('request', this.onRequest);
        }

        return this.#page;
    }

    private onRequest(request: puppeteer.HTTPRequest) {
        const resourceType = request.resourceType();
        switch (resourceType) {
            case 'image':
            case 'font': {
                request.abort();
                break;
            }
            default: {
                const domain = /(.*\.)?xfinity\.com.*/;
                const url = request.url();
                if (domain.test(url)) {
                    request.continue();
                } else {
                    request.abort();
                }
            }
        }
    }

    private async waitForSelectorVisible(...selectors: string[]) {
        const page = await this.getPage();
        const items = selectors.map((selector) => page.waitForSelector(selector, { timeout: 30000, visible: true }));

        return Promise.all(items);
    }

    private async saveCookies() {
        logger.debug('Saving cookies for next fetch');
        const page = await this.getPage();
        const cookies = await page.cookies();
        await writeCookies(cookies);
    }

    private async screenshot(filename: string) {
        const page = await this.getPage();
        console.log(filename, page.url());
        return await page.screenshot({ path: `${filename}-${Date.now()}.png` });
        // return page.screenshot({ path: `/config/screenshots/${filename}.png` });
    }
}
