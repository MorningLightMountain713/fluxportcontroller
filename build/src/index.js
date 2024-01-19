"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FluxEchoServer = exports.FluxGossipServer = void 0;
const fluxGossipServer_1 = require("./fluxport-controller/fluxGossipServer");
const fluxEchoServer_1 = require("./fluxport-controller/fluxEchoServer");
var fluxportcontroller;
(function (fluxportcontroller) {
    fluxportcontroller.FluxGossipServer = fluxGossipServer_1.FluxGossipServer;
    fluxportcontroller.FluxEchoServer = fluxEchoServer_1.FluxEchoServer;
})(fluxportcontroller || (fluxportcontroller = {}));
var fluxGossipServer_2 = require("./fluxport-controller/fluxGossipServer");
Object.defineProperty(exports, "FluxGossipServer", { enumerable: true, get: function () { return fluxGossipServer_2.FluxGossipServer; } });
var fluxEchoServer_2 = require("./fluxport-controller/fluxEchoServer");
Object.defineProperty(exports, "FluxEchoServer", { enumerable: true, get: function () { return fluxEchoServer_2.FluxEchoServer; } });
exports.default = fluxportcontroller;
