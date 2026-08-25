"use strict";

function notImplemented() {
  const error = new Error("Settings feature is not implemented in this foundation child");
  error.code = "TEST_NOT_IMPLEMENTED";
  error.status = 501;
  throw error;
}

module.exports = { notImplemented };
