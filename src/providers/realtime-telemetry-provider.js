/*****************************************************************************
 * Open MCT, Copyright (c) 2014-2020, United States Government
 * as represented by the Administrator of the National Aeronautics and Space
 * Administration. All rights reserved.
 *
 * Open MCT is licensed under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0.
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations
 * under the License.
 *
 * Open MCT includes source code licensed under additional open source
 * licenses. See the Open Source Licenses file (LICENSES.md) included with
 * this source code distribution or the Licensing information page available
 * at runtime from the About dialog for additional information.
 *****************************************************************************/

import * as OBJECT_TYPES from '../const';
import {
    idToQualifiedName,
    qualifiedNameToId,
    getValue,
    addLimitInformation
} from '../utils.js';

const WS_IDLE_INTERVAL_MS = 10000;
const FALLBACK_AND_WAIT_MS = [1000, 5000, 5000, 10000, 10000, 30000];

/* CSS classes for Yamcs parameter monitoring result values. */
const MONITORING_RESULT_CSS = {
    'WATCH': 'is-limit--yellow',
    'WARNING': 'is-limit--yellow',
    'DISTRESS': 'is-limit--red',
    'CRITICAL': 'is-limit--red',
    'SEVERE': 'is-limit--red'
}

/* CSS classes for Yamcs range condition values. */
const RANGE_CONDITION_CSS = {
    'LOW': 'is-limit--lwr',
    'HIGH': 'is-limit--upr'
}


/*
 * Implements an OpenMCT limit evaluator that uses limit information passed
 * from either the historical or realtime telemetry source to create limit
 * information for OpenMCT.
 */
class LimitEvaluator {

    /*
     * Evaluates a telemetry point for limit violations.
     *
     * Parameters:
     *     datum: the telemetry point data from the historical or realtime
     *            plugin
     *     valueMetadata: metadata about the telemetry point, not used
     *
     * Returns:
     *     an object with CSS class information, a violation name, and
     *     range information, if there is a limit violates, or nothing,
     *     if the value is within limits.
     *
     * The datum parameter may include the following information:
     *     monitoringResult: the Yamcs limit monitoring result, if any
     *     rangeCondition: the Yamcs range condition (LOW/HIGH), if any
     *     alarmRange: an array of alarm ranges for different monitoring
     *         results, or omitted, if no alarm ranges are defined
     */
    evaluate(datum, valueMetadata) {
        if (datum.monitoringResult
            && datum.monitoringResult in MONITORING_RESULT_CSS) {
            let evaluationResult = {
                cssClass: MONITORING_RESULT_CSS[datum.monitoringResult],
                name: datum.monitoringResult
            }
            if (datum.rangeCondition
                && datum.rangeCondition in RANGE_CONDITION_CSS) {
                evaluationResult.cssClass += ' '
                evaluationResult.cssClass += RANGE_CONDITION_CSS[datum.rangeCondition]
                this.addLimitRange(datum, datum.monitoringResult, evaluationResult)
            }
            return evaluationResult
        }
    }

    /*
     * Adds limit range information to an object based on the monitoring
     * result.
     *
     * Parameters:
     *     datum: the telemetry point data from the historical or realtime
     *            plugin
     *     result: the monitoring result information from Yamcs
     *     evaluationResult: the object that is to be the result of the
     *                       limit evaluation
     */
    addLimitRange(datum, result, evaluationResult) {
        let range = this.findAlarmRange(datum, result)
        if (range === undefined) {
            return
        }
        if (range.minInclusive) {
            evaluationResult.low = range.minInclusive
        }
        if (range.minExclusive) {
            evaluationResult.low = range.minExclusive
        }
        if (range.maxInclusive) {
            evaluationResult.high = range.maxInclusive
        }
        if (range.maxExclusive) {
            evaluationResult.high = range.maxExclusive
        }
    }

    /*
     * Finds the appropriate limit range for a monitoring results.
     */
    findAlarmRange(datum, result) {
        if (datum.alarmRange !== undefined) {
            return datum.alarmRange.find(range => range.level == result)
        }
    }
}

export default class RealtimeTelemetryProvider {
    constructor(url ,instance) {
        this.url = url;
        this.instance = instance;
        this.seqNo = 0;
        this.connected = false;
        this.listener = {};
        this.requests = [];
        this.currentWaitIndex = 0;
        this.supportedTypes = {};

        this.addSupportedTypes();
    }

    addSupportedTypes() {
        const types = Object.values(OBJECT_TYPES);
        types.forEach(type => {
            this.supportedTypes[type] = type;
        });
    }

    supportsSubscribe(domainObject) {
        return this.supportedTypes[domainObject.type];
    }

    supportsLimits(domainObject) {
        return domainObject.type.startsWith('yamcs.');
    }

    subscribe(domainObject, callback) {
        const id = domainObject.identifier.key;
        this.listener[id] = callback;

        if (id === OBJECT_TYPES.EVENTS_OBJECT_TYPE) {
            return this.subscribeToEvent(id);
        } else {
            let name = idToQualifiedName(id);
            return this.subscribeToTelemetry(name, id);
        }
    }

    subscribeToTelemetry(name, id) {
        if (this.connected) {
            this.tlmSubscribe(name);
        }

        return () => {
            this.tlmUnsubscribe();
            delete this.listener[id];
        };
    }

    subscribeToEvent(id) {
        if (this.connected) {
            this.eventSubscribe();
        }

        return () => {
            this.eventUnsubscribe();
            delete this.listener[id];
        };
    }

    getLimitEvaluator(domainObject) {
        return new LimitEvaluator()
    }

    resubscribeToAll() {
        Object.keys(this.listener).forEach((id) => {
            if (id === OBJECT_TYPES.EVENTS_OBJECT_TYPE) {
                this.eventSubscribe();
            } else {
                let name = idToQualifiedName(id);
                this.tlmSubscribe(name);
            }
        });
    }

    connect() {
        if (this.connected) {
            return;
        }
        let wsUrl = `${this.url}_websocket/${this.instance}`;
        this.seqNo = 0;
        this.connected = false;
        this.socket = new WebSocket(wsUrl);

        this.socket.onopen = () => {
            clearTimeout(this.reconnectTimeout);

            this.keepAliveInterval = setInterval(
                this.idleSubscribe.bind(this), WS_IDLE_INTERVAL_MS);
            this.connected = true;
            console.log(`Established websocket connection to ${wsUrl}`);

            this.currentWaitIndex = 0;
            this.resubscribeToAll();
            this.flushQueue();
        };

        this.socket.onmessage = (event) => {
            let data = JSON.parse(event.data);

            if (data.length < 4) {
                return;
            }

            const dataType = data[3].dt;
            if (dataType === 'PARAMETER') {
                data[3].data.parameter.forEach(parameter => {
                    let point = {
                        id: qualifiedNameToId(parameter.id.name),
                        timestamp: parameter.generationTimeUTC,
                        value: getValue(parameter.engValue)
                    }
                    addLimitInformation(parameter, point)

                    if (this.listener[point.id]) {
                        this.listener[point.id](point);
                    }
                });
            }

            if (dataType === 'EVENT') {
                if (this.listener[OBJECT_TYPES.EVENTS_OBJECT_TYPE]) {
                    this.listener[OBJECT_TYPES.EVENTS_OBJECT_TYPE](data[3].data);
                }
            }
        };

        this.socket.onerror = (error) => {
            console.error(error);
            console.warn("Websocket error, attempting reconnect...");
            this.connected = false;
            this.reconnect();
        };

        this.socket.onclose = () => {
            this.connected = false;
            console.warn("Websocket closed. Attempting to reconnect...");
            this.reconnect();
        };
    }

    reconnect() {
        if (this.reconnectTimeout) {
            return;
        }

        this.reconnectTimeout = setTimeout(() => {
            this.connect();
            delete this.reconnectTimeout;
        }, FALLBACK_AND_WAIT_MS[this.currentWaitIndex]);

        if (this.currentWaitIndex < FALLBACK_AND_WAIT_MS.length) {
            this.currentWaitIndex++;
        }
    }

    idleSubscribe() {
        Object.keys(this.listener).forEach((id) => {
            if (id === OBJECT_TYPES.EVENTS_OBJECT_TYPE) {
                this.eventSubscribe();
            } else {
                this.idleTlmSubscribe();
            }
        });
    }

    idleTlmSubscribe() {
        this.sendOrQueueRequest('{"parameter": "subscribe", "data": { "id": [] }}');
    }

    tlmSubscribe(id) {
        this.sendOrQueueRequest(`{"parameter": "subscribe",
                     "data": { "id": [{ "name": "${id}" }],
                     "sendFromCache": false }}`);
    }

    eventSubscribe() {
        this.sendOrQueueRequest("{'events': 'subscribe'}");
    }

    tlmUnsubscribe(id) {
        this.sendOrQueueRequest(`{"parameter": "unsubscribe",
                     "data": { "id": [{ "name": "${id}" }] }}`);
    }

    eventUnsubscribe() {
        this.sendOrQueueRequest("{'events': 'unsubscribe'}");
    }

    sendOrQueueRequest(request) {
        if (this.connected) {
            try {
                this.sendRequest(request);
                return true;
            } catch (error) {
                this.connected = false;
                console.error(error);
                console.warn("Error while attempting to send to websocket. Reconnecting...");

                this.requests.push(request);
                this.reconnect();
            }
        } else {
            this.requests.push(request);
        }
    }

    flushQueue() {
        let shouldReconnect = false;
        this.requests = this.requests.filter((request) => {
            try {
                this.sendRequest(request);
            } catch (error) {
                this.connected = false;
                console.error(error);
                console.warn("Error while attempting to send to websocket. Reconnecting...");

                shouldReconnect = true;
                return true;
            }
            return false;
        });

        if (shouldReconnect) {
            this.reconnect();
        }
    }

    sendRequest(request) {
        let payload = '[1, 1, ' + (++this.seqNo) + ', ' + request + ']';
        this.socket.send(payload);
    }
}
