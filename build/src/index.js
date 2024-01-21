"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logController = exports.FluxEchoServer = exports.FluxGossipServer = void 0;
const fluxGossipServer_1 = require("./fluxport-controller/fluxGossipServer");
const fluxEchoServer_1 = require("./fluxport-controller/fluxEchoServer");
const impLogController = __importStar(require("./fluxport-controller/log"));
var fluxportcontroller;
(function (fluxportcontroller) {
    fluxportcontroller.FluxGossipServer = fluxGossipServer_1.FluxGossipServer;
    fluxportcontroller.FluxEchoServer = fluxEchoServer_1.FluxEchoServer;
    fluxportcontroller.LogController = impLogController;
})(fluxportcontroller || (fluxportcontroller = {}));
var fluxGossipServer_2 = require("./fluxport-controller/fluxGossipServer");
Object.defineProperty(exports, "FluxGossipServer", { enumerable: true, get: function () { return fluxGossipServer_2.FluxGossipServer; } });
var fluxEchoServer_2 = require("./fluxport-controller/fluxEchoServer");
Object.defineProperty(exports, "FluxEchoServer", { enumerable: true, get: function () { return fluxEchoServer_2.FluxEchoServer; } });
exports.logController = __importStar(require("./fluxport-controller/log"));
exports.default = fluxportcontroller;
