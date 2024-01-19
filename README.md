# Fluxport Controller

Fluxport autoconf, gossip and ping servers. Uses multicast for
nodes to communicate and autoconfigure their own ports.

## Installation

```bash
npm i @megachips/fluxport-controller
```

## Usage

```javascript
// using ES modules
import { fluxGossipServer } from "@megachips/fluxport-controller";
const gossipServer = new FluxGossipServer();

// using node require
const fluxportController = require("@megachips/fluxport-controller");
const gossipServer = new fluxportController.FluxGossipServer();

// real world example

// confirmation tx of this node
const outPoint = {
  txhash: "334896be9aacb757de3e01633eba12b30198612513289223ca355d52137ba221",
  outidx: "0"
};

const fluxMulticastGroup = "239.112.233.123"
const fluxMulticastPort = 16127 // this is UDP

const gossipServer = new FluxGossipServer(
  outPoint,
  fluxMulticastGroup,
  fluxMulticastPort
);

gossipServer.on("portConfirmed", (port) => {
  console.log(`My port is : ${port}`)
});

gossipServer.start()
```

### License

This software is licensed under the MIT License.

Copyright David White, 2023.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.

### Development notes
```bash
echo -n '?#!%%!#?{"type":"DISCOVER", "host":"172.16.32.11"}?#!%%!#?' | nc -w0 -u 239.16.32.15 16137
```
