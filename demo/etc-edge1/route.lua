-- Demo Lua action. It selects a backend, which is exactly the case the
-- configuration cannot express: nothing in haproxy.cfg says api-in can reach
-- health-back this way, so the service view has to say it cannot see it.
core.register_action("pick_backend", { "http-req" }, function(txn)
    if txn.sf:req_hdr("x-lua-route") == "health" then
        txn:set_var("txn.picked", "health-back")
    end
end)
