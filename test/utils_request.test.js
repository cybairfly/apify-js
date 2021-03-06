import express from 'express';
import {
    requestAsBrowser,
} from '../build/utils_request';
import { startExpressAppPromise } from './_helper';

const CONTENT = 'CONTENT';
const HOSTNAME = '127.0.0.1';

describe('Apify.utils_request', () => {
    let port;
    let server;
    beforeAll(async () => {
        const app = express();

        app.get('/406', (req, res) => {
            res.setHeader('content-type', 'text/html; charset=utf-8');
            res.status(406);
            res.send(CONTENT);
        });

        app.get('/echo', (req, res) => {
            res.send(JSON.stringify(req.headers));
        });

        app.get('/rawHeaders', (req, res) => {
            res.send(JSON.stringify(req.rawHeaders));
        });

        app.get('/invalidContentType', (req, res) => {
            res.setHeader('content-type', 'application/json');
            res.send(CONTENT);
        });

        app.get('/invalidContentHeader', (req, res) => {
            res.setHeader('Content-Type', 'non-existent-content-type');
            res.send(CONTENT);
        });

        app.get('/invalidBody', async (req, res) => {
            res.setHeader('content-encoding', 'deflate');
            res.status(500);
            res.send(Buffer.from(CONTENT, 'utf8'));
        });

        app.get('/empty', async (req, res) => {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.send();
        });

        app.post('/echo-body', async (req, res) => {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            req.pipe(res);
        });

        app.get('/invalidHeaderChar', (req) => {
            const headers = {
                'Invalid Header With Space': 'some\value',
                'X-Normal-Header': 'HeaderValue2',
            };

            let msg = 'HTTP/1.1 200 OK\r\n';
            Object.entries(headers).forEach(([key, value]) => {
                msg += `${key}: ${value}\r\n`;
            });
            msg += `\r\n${CONTENT}`;

            req.socket.write(msg, () => {
                req.socket.end();

                // Unfortunately calling end() will not close the socket
                // if client refuses to close it. Hence calling destroy after a short while.
                setTimeout(() => {
                    req.socket.destroy();
                }, 100);
            });
        });

        server = await startExpressAppPromise(app, 0);
        port = server.address().port; //eslint-disable-line
    });

    afterAll(() => {
        server.close();
    });

    describe('Apify.requestAsBrowser', () => {
        test(
            'it uses mobile user-agent when mobile property is set to true ',
            async () => {
                const data = {
                    url: `http://${HOSTNAME}:${port}/echo`,
                    useMobileVersion: true,
                };
                const response = await requestAsBrowser(data);
                expect(response.statusCode).toBe(200);
                expect(response.request.options.context.headerGeneratorOptions.devices).toEqual(['mobile']);
            },
        );

        test('uses desktop user-agent by default ', async () => {
            const data = {
                url: `http://${HOSTNAME}:${port}/echo`,
            };
            const response = await requestAsBrowser(data);
            expect(response.statusCode).toBe(200);
            expect(response.request.options.context.headerGeneratorOptions.devices).toEqual(['desktop']);
        });

        test('sets correct hosts', async () => {
            const host = `${HOSTNAME}:${port}`;
            const options = {
                url: `http://${host}/echo`,
            };

            const response = await requestAsBrowser(options);

            expect(response.statusCode).toBe(200);
            expect(JSON.parse(response.body).host).toEqual(host);
        });

        test('uses correct default language', async () => {
            const languageCode = 'en';
            const countryCode = 'US';
            const host = `${HOSTNAME}:${port}`;
            const options = {
                url: `http://${host}/echo`,
            };

            const response = await requestAsBrowser(options);

            expect(response.statusCode).toBe(200);
            expect(response.request.options.context.headerGeneratorOptions.locales).toEqual([`${languageCode}-${countryCode}`]);
        });

        test('does not throw for empty response body', async () => {
            const options = {
                url: `http://${HOSTNAME}:${port}/empty`,
            };
            let error;
            try {
                await requestAsBrowser(options);
            } catch (e) {
                error = e;
            }

            expect(error).toBeFalsy(); //eslint-disable-line
        });

        test('overrides defaults', async () => {
            const host = `${HOSTNAME}:${port}`;
            const options = {
                url: `http://${host}/echo`,
                headers: {
                    'User-Agent': 'chrome',
                },
            };

            const response = await requestAsBrowser(options);

            expect(response.statusCode).toBe(200);
            expect(JSON.parse(response.body)['user-agent']).toEqual(options.headers['User-Agent']);
        });

        test('custom headers in uppercase for HTTP1', async () => {
            const host = `${HOSTNAME}:${port}`;
            const options = {
                url: `http://${host}/rawHeaders`,
                headers: {
                    Accept: 'foo',
                    bar: 'BAZ',
                },
                useHttp2: false,
            };

            const response = await requestAsBrowser(options);
            expect(response.statusCode).toBe(200);
            expect(response.request.options.headers).toMatchObject(options.headers);
        });

        test('correctly handles invalid header characters', async () => {
            const url = `http://${HOSTNAME}:${port}/invalidHeaderChar`;

            const response = await requestAsBrowser({ url });
            expect(response.body).toBe(CONTENT);
            expect(response.headers).toEqual({
                'invalid header with space': 'some\value',
                'x-normal-header': 'HeaderValue2',
            });
            try {
                await requestAsBrowser({
                    useInsecureHttpParser: false,
                    url,
                });
            } catch (err) {
                if (process.version.startsWith('v10')) {
                    expect(err.message).toMatch('Parse Error');
                } else {
                    expect(err.message).toMatch('Parse Error: Invalid header value char');
                }
            }
        });

        test('does not get into redirect loops', async () => {
            const url = 'https://www.smartmania.cz'; // uses www to no-www redirect
            try {
                await requestAsBrowser({ url });
            } catch (err) {
                // If it's some other error, it's fine for the purpose of this test.
                // We're only making sure that the max redirect error is not there.
                if (err.name === 'MaxRedirectsError') throw err;
            }
        });

        // TODO we need to do this better, it will be flaky. The test above is not flaky,
        // because it only checks for a very specific error so it won't fail on network errors.
        test('works with useHttp2', async () => {
            const url = 'https://apify.com';
            const response = await requestAsBrowser({ url, useHttp2: true });
            // TODO Node v10 does not support HTTP2 well, remove when we drop support.
            if (process.version.startsWith('v10')) {
                expect(response.request.options.http2).toBe(false);
            } else {
                expect(response.request.options.http2).toBe(true);
            }
            expect(response.body.length).toBeGreaterThan(10000);
        });

        // TODO same here
        test('get works with streams', async () => {
            const response = await requestAsBrowser({
                url: 'https://apify.com/',
                stream: true,
            });
            expect(response.options.isStream).toBe(true);
            const chunks = [];
            for await (const chunk of response) {
                chunks.push(chunk);
            }
            const body = chunks.join();
            expect(body.length).toBeGreaterThan(10000);
        });

        test('post works with streams', async () => {
            const response = await requestAsBrowser({
                method: 'POST',
                url: `http://${HOSTNAME}:${port}/echo-body`,
                stream: true,
                payload: 'TEST',
            });
            expect(response.options.isStream).toBe(true);
            const chunks = [];
            for await (const chunk of response) {
                chunks.push(chunk);
            }
            const body = chunks.join();
            expect(body).toBe('TEST');
        });
    });
});
