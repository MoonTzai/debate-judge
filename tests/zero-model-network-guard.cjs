'use strict';
// Verification-only preload. Never loaded by the product runtime or real acceptance runner.
// Each preflight Node child inherits this guard through its process-local NODE_OPTIONS.
const key=Symbol.for('debate-judge.zero-model-network-guard');
if(!globalThis[key]){
  const state={enabled:true,blockedCalls:0};
  const deny=label=>function(){
    state.blockedCalls++;
    const error=new Error('ZERO_MODEL_NETWORK_FORBIDDEN: '+label);
    error.code='ERR_ZERO_MODEL_NETWORK_FORBIDDEN';
    throw error;
  };
  globalThis.fetch=async function(){return deny('fetch')();};
  for(const name of ['http','https']){
    const module=require(name);module.request=deny(name+'.request');module.get=deny(name+'.get');
  }
  const net=require('net');net.connect=deny('net.connect');net.createConnection=deny('net.createConnection');
  net.Socket.prototype.connect=deny('Socket.connect');
  require('tls').connect=deny('tls.connect');
  globalThis[key]=state;
}
module.exports=globalThis[key];
