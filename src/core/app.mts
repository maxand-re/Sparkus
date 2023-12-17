import { Logger, SparkusLoggerLevel } from "../utils/index.mjs";
import {
    ControllerData,
    EndpointData,
    InjectLogger
} from "../decorators/index.mjs";

import path from "node:path";
import * as fs from "fs";
import { Server } from "./server.mjs";
import { Router } from "./router.mjs";
import chokidar, { FSWatcher } from "chokidar";
import * as url from "url";
import { Watcher } from "../utils/watcher.mjs";

export enum SparkusDataType {
    Controller,
    Service,
    Endpoint,
}

export interface SparkusClass extends Function {
    _sparkus: SparkusData;
    constructor: any;
}

export interface SparkusData {
    type: SparkusDataType;
    data: any;
}

interface BootstrapConfig {
    scan: string[];
    port?: number;
    logger?: {
        level?: SparkusLoggerLevel;
    };
    watch?: boolean;
    cwd?: string;
}

@InjectLogger
export class App {
    private readonly scan: URL[];
    private readonly port: number;
    private readonly server: Server;
    private readonly router: Router;
    private readonly watcher: Watcher;
    private readonly isWatcherEnabled: boolean = false;
    private readonly urlControllerMap: Map<string, ControllerData> = new Map<
        string,
        ControllerData
    >();

    private logger: Logger;

    constructor(config: BootstrapConfig) {
        const cwd = config.cwd ?? url.pathToFileURL(process.cwd() + "/");

        this.scan = config.scan.map((value) => new URL(value, cwd));
        this.port = config.port ?? 8080;

        if (config.logger) Logger.level = config.logger.level;
        this.isWatcherEnabled = config.watch;

        this.watcher = new Watcher(config.scan, config.cwd);
        this.router = new Router();
        this.server = new Server(this.port, this.router);
    }

    async start(): Promise<void> {
        const before = Date.now();

        // Initialize the watcher if enabled
        if (this.isWatcherEnabled) {
            this.watcher.init(this);
        }

        // Scan all the files and get all routes asynchronously
        const loadPromises: Promise<void>[] = [];
        for (const url of this.scan) {
            this.logger.debug(`Starting scan search on "${url}"`);
            const promises = this.scanFolder(url);
            loadPromises.push(...promises);
        }
        await Promise.all(loadPromises);

        // Start listening with the configured SparkusServer
        this.server.listen();

        this.logger.debug(`Server started in "${Date.now() - before}ms"`);
    }

    private scanFolder(url: URL): Promise<void>[] {
        const files = fs.readdirSync(url);

        const loadPromises: Promise<void>[] = [];

        files.forEach(file => {
            const fileUrl = new URL(path.join(url.toString(), file));

            if (fs.lstatSync(fileUrl).isDirectory()) {
                const promises = this.scanFolder(fileUrl);
                loadPromises.push(...promises);
            } else {
                const promise = this.loadFile(fileUrl).then(({isLoaded, controller}) => {
                    if (!isLoaded)
                        this.logger.warn(
                            `File can't load (not a valid Sparkus class): "${fileUrl}"`
                        );
                    else
                        this.logger.info(
                            `Controller "${controller.name}" successfully added.`
                        );
                });

                loadPromises.push(promise);
            }
        });

        return loadPromises;
    }

    async unloadFile(url: URL): Promise<boolean> {
        const controller = this.urlControllerMap.get(url.pathname);

        if (controller) {
            this.router.removeController(controller);
            return true;
        }

        return false;
    }

    async loadFile(file: URL): Promise<{ isLoaded: boolean, controller?: ControllerData }> {
        this.logger.debug(`Loading file "${file}"...`);

        if (file.pathname.endsWith(".d.ts") || file.pathname.endsWith(".d.mts")) return { isLoaded: false };

        const imported = this.watcher
            ? await this.watcher.dynamicImport(file)
            : (await import(file.toString())).default;

        if (!imported) return { isLoaded: false };

        const sparkusData: SparkusData = new imported()._sparkus;

        if (!sparkusData) return { isLoaded: false };

        if (sparkusData.type === SparkusDataType.Controller) {
            const controller = sparkusData.data as ControllerData;

            this.logger.debug(`Loading controller "${controller.name}"...`);

            const methods = Object.getOwnPropertyDescriptors(
                controller.constructor.prototype
            );

            Object.keys(methods).forEach((methodName: string) => {
                if (methods[methodName].value._sparkus) {
                    let methodData: SparkusData =
                        methods[methodName].value._sparkus;

                    const isEndpoint =
                        methodData.type === SparkusDataType.Endpoint;

                    if (isEndpoint) {
                        const endpoint = methodData.data as EndpointData;
                        controller.endpoints.push(endpoint);
                    }
                }
            });

            this.router.addController(controller);
            this.urlControllerMap.set(file.pathname, controller);

            return { isLoaded: true, controller };
        }

        return { isLoaded: false };
    }
}
