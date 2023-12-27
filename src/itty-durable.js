import {
    error,
    json,
    status,
    StatusError,
    Router,
    withParams
} from 'itty-router';
import { proxyDurable } from './proxy-durable';
import superjson from 'superjson';

// factory function for IttyDurable with custom options
export const createDurable = (options = {}) => {
    const {
        autoPersist = false,
        autoReturn = false,
        prefix = '_itty:',
        onError = (err) => error(err.status || 500, err.message)
    } = options;

    return class IttyDurable {
        constructor(state = {}, env = {}) {
            this.env = env;
            this.classInstance = null;
            this.state = {
                defaultState: undefined,
                initialized: false,
                router: Router(),
                env,
                ...env,
                ...state
            };

            // embed bindings into this.env
            for (const [key, binding] of Object.entries(env)) {
                this.state[key] =
                    typeof binding.idFromName === 'function'
                        ? proxyDurable(binding, { name: key, parse: true })
                        : binding;
            }

            // creates a proxy of this to return
            const proxied = new Proxy(this, {
                get: (obj, prop, receiver) =>
                    typeof obj[prop] === 'function'
                        ? obj[prop].bind(receiver)
                        : obj[prop],

                set: (obj, prop, value) => {
                    obj[prop] = value;

                    return true;
                }
            });

            // one router to rule them all
            this.state.router.get(
                '/do/:action/:target',
                withParams,
                async (request, env) => {
                    const { action, headers, target } = request;
                    const content = JSON.parse(
                        headers.get('do-content') || '[]'
                    );

                    if (action === 'call') {
                        if (typeof this[target] !== 'function') {
                            throw new StatusError(
                                500,
                                `Durable Object does not contain method ${target}()`
                            );
                        }
                        const response = await proxied[target](...content);

                        // return early if response detected
                        if (response !== undefined) {
                            return response instanceof Response
                                ? response
                                : json(response);
                        }
                    } else if (action === 'set') {
                        proxied[target] = content;
                    } else if (action === 'get-prop') {
                        return json(await proxied[target]);
                    }
                },
                proxied.optionallyReturnThis,
                () => status(204)
            );

            return proxied;
        }

        // purge storage, and optionally reset internal memory state
        async destroy(options = {}) {
            const { reset = false } = options;

            await this.state.storage.deleteAll();

            if (reset) {
                this.reset();
            }

            const destructionResponse = await this.onDestroy();

            // optionally return if onDestroy returns something
            if (destructionResponse) {
                return destructionResponse;
            }
        }

        getAlarm() {
            return this.state.storage.getAlarm();
        }

        setAlarm(expiration) {
            return this.state.storage.setAlarm(expiration);
        }

        // fetch method is the expected interface method of Durable Objects per Cloudflare spec

        async safeAlarm(cb) {
            try {
                this.state.storage.transaction(async (txn) => {
                    const alteredState = { ...this.state, storage: txn };
                    this.state = alteredState;
                    await this.loadFromStorage();
                    if (cb) {
                        await cb();
                    }
                    if (autoPersist) {
                        await this.persist();
                    }
                });
            } catch (e) {
                console.log(e);
            }
        }

        async fetch(request, ...args) {
            let response;
            try {
                const { method, url, headers } = request;
                const idFromName = request.headers.get('do-name');
                this.state.websocketRequest =
                    request.headers.get('upgrade')?.toLowerCase() ===
                    'websocket';
                this.state.request = request;
                let response;

                if (idFromName) {
                    this.state.idFromName = idFromName;
                }

                // save default state for reset
                if (!this.state.initialized) {
                    this.state.defaultState = JSON.stringify(
                        this.getPersistable()
                    );
                }

                // load initial state from storage (if found)
                await this.loadFromStorage();

                // we pass off the request to the internal router
                response = await this.state.router
                    .handle(request, ...args)
                    .catch(onError);

                /*				if (response.status >= 400) {
						// TODO: upgrade to not always eject from memory on errors. Not sure how to decide.
						txn.rollback(); // explicit rollback whenever there is a non-2xx, non-3xx response
						this.classInstance = null; // reset the class instance so all memory will be rehydrated from storage on next request
					}*/

                if (!response && this.fetchFallback) {
                    return this.fetchFallback();
                }

                // if persistOnChange is true, we persist on every response
                if (autoPersist) {
                    // добавил await
                    await this.persist();
                }

                // provide an escape hatch for things like Alarms

                // then return the response
                if (response) return response;
                throw new Error('Bad request to durable object');
            } catch (e) {
                console.log(e, ' error');

                return error(400, e);
            }

            return response;
        }

        // gets persistable state (defaults to all but itty data)
        getPersistable() {
            const { state, ...persistable } = this;

            return persistable;
        }

        async loadFromStorage() {
            if (!this.state.initialized) {
                const stored = await this.state.storage.list({
                    prefix,
                    limit: 100
                });
                const stateObj = {};

                for (const [key, value] of stored) {
                    const truncatedKey = key.startsWith(prefix)
                        ? key.slice(prefix.length)
                        : key;
                    const obj = superjson.parse(value);
                    stateObj[truncatedKey] = obj;
                }

                Object.assign(this, stateObj);

                // then run afterInitialization lifecycle function
                await this.onLoad();

                this.state.initialized = true;
            }
        }

        async onDestroy() {
            // fires after this.destroy() is called
        }

        async onLoad() {
            // fires after object is loaded from storage
        }

        // returns self from methods that fail to return if autoReturn flag is enabled
        optionallyReturnThis() {
            if (autoReturn) {
                return json(this.toJSON ? this.toJSON() : this);
            }
        }

        // persists to storage, override to control
        async persist() {
            const { state, ...persistable } = this.getPersistable();
            await Promise.all(
                Object.keys(persistable).map((propertyName) => {
                    if (!propertyName.startsWith('$')) {
                        const object = superjson.stringify(
                            persistable[propertyName]
                        );
                        this.state.storage.put(
                            `${prefix}${propertyName}`,
                            object
                        );
                    }
                })
            );
        }

        // resets object to preserved default state
        async reset() {
            const { state, ...persistable } = this.getPersistable();

            for (const key in persistable) {
                Reflect.deleteProperty(this, key);
            }

            // reset to defaults from constructor
            Object.assign(this, JSON.parse(this.state.defaultState));
        }

        // defaults to returning all content
        toJSON() {
            const { state, ...other } = this;

            return other;
        }
    };
};
