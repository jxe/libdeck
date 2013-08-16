var db = {}; // legacy



// UTILS: RESILIENT JSON PARSING

if (!window.JSONparse) window.JSONparse = function(json, label){
  try { return JSON.parse(json); }
  catch(e){
    console_log('Bad JSON...');
    if (label) console_log('Label:' + label);
    console_log(json);
    console_log(e);
    return {};
  }
};



// UTILS: ASYNC CALLS

function coalesce_calls (old_fn, new_fn, delay) {
  var requested;
  if (!coalesce_calls.requests) coalesce_calls.requests = {};
  window[new_fn] = function() {
    if (requested) return;
    requested = true;
    setTimeout(function(){
      requested = false;
      window[old_fn]();
    }, delay);
  };
}



// FOLLOW AND SUBSCRIBE

var newmsg_fns_by_type = {};
var latest = {};

function load_relevant_start_msgs(types, newmsgs){
  if (!window.start_msgs || start_msgs.length === 0) return;
  var matching = [], non_matching = [];
  start_msgs.forEach(function(m){
    if (types.indexOf(m.type) > -1) matching.push(m);
    else non_matching.push(m);
  });
  start_msgs = non_matching;
  newmsgs(matching);
}

function subscribe(){
  if (subscribe.active_channel) PUBNUB.unsubscribe({channel:subscribe.active_channel});
  subscribe.active_channel = SERVER.split(':')[1].slice(2) + ":"+myid();
  PUBNUB.subscribe({
    channel  : subscribe.active_channel,
    callback : function(m) {
      console_log('subscribe got', m);
      process_msg(m);
    },
    reconnect: function(){ request_follow(); console_log('PUBNUB RECONNECTED: ' + subscribe.active_channel); }
  });
}

coalesce_calls('follow', 'request_follow', 0);
coalesce_calls('request_follow', 'request_follow_in_10m', 10*60*1000);
coalesce_calls('request_follow', 'request_follow_in_10s', 10*1000);

function follow (force, world) {
  var l = world ? world.latest : latest;
  if (!window.SERVER) return;
  if (!Object.keys(l).length) return;

  $.ajax({
    url: SERVER+'/' + ((world&&world.endpoint) || 'follow'),
    data: {latest:JSON.stringify(l), user: JSON.stringify(user)},
    dataType:'json',
    success: function(msgs) {
      world || request_follow_in_10m();
      msgs.forEach(function(m) { process_msg(m, true, world); });
    },
    error:function(){
      console.log('follow error');
      world || request_follow_in_10s();
    }
  });
}

function noop() {
  if (!window.SERVER) return;
  $.ajax({
    url: SERVER+'/noop',
    data: {user: JSON.stringify(user)},
    dataType:'json',
    success: function(msgs) {},
    error:function(){ console.log('noop error'); }
  });
}


function isEmpty(object) { for(var i in object) { return true; } return false; }

function clear_latest_of_types(types){
  values(latest).forEach(function(v){
    types.forEach(function(t){ delete v[t]; });
  });
  for (var k in latest){
    if (isEmpty(latest[k])) delete latest[k];
  }
}

function rmerge (into, from) {
  for (var k in from){
    if (!into[k]) into[k] = from[k];
    else if (typeof(into[k]) == 'object') rmerge(into[k], from[k]);
  }
}

function subobj (hash, k2s) {
  var sub = {};
  k2s = setify(k2s);
  for (var k1 in hash){
    for (var k2 in hash[k1]){
      if (!k2s[k2]) continue;
      if (!sub[k1]) sub[k1] = {};
      sub[k1][k2] = hash[k1][k2];
    }
  }
  return sub;
}


function please_follow (types, db_latest, newmsgs, world) {
  var l = world ? world.latest : latest;
  load_relevant_start_msgs(types, newmsgs);
  rmerge(l, db_latest);
  if (!world) types.forEach(function(t){ newmsg_fns_by_type[t] = newmsgs; });
  else world.newmsg= newmsgs;
  if (world) follow(null, world);
  else request_follow();
}


// var last_request_follow_fallback;
// function request_follow_fallback(){
//   if (last_request_follow_fallback && last_request_follow_fallback.
// }


function process_reload(msg){
  msg.split(',').forEach(function(dbname){ window[dbname].clear(); });
}

function process_stub(stub, world){
  $.ajax({
    url: SERVER+'/msgs/'+stub,
    dataType:'json',
    success: function(m) { process_msg(m, true, world); },
    error:function(){
      console.log('stub error');
      if (!world) request_follow_in_10s();
    }
  });
}

function process_msg (m, avoiding_reboots, world) {
  if (m.type == 'reload') return process_reload(m.msg);
  if (m.stub) return process_stub(m.stub, world);
  var l = world ? world.latest : latest;

  var reboot_required, is_new = true;
  var f;
  if (!world) f = newmsg_fns_by_type[m.type];
  else f = world.newmsg;
  if (!f) { console.log('msg of Unrecognized type: ' + m.type); return; }

  if (m.was){
    for (var k in m.was){
      if (!m.was[k] || !l[k] || !l[k][m.type]) continue;
      if (l[k][m.type] != m.was[k]){
        if (m._id == l[k][m.type]) { is_new = false; continue; }
        else {
          console.log('Message '+m._id+' of type ' + m.type + ' applies on ' + k + ':' + m.was[k] + ' but we have ' + k + ':' + l[k][m.type]);
          if (!avoiding_reboots) reboot_required = true;
        }
      }
    }
  }

  if (is_new && !reboot_required){
    f([m]);
    if (m.to) m.to.forEach(function(t) {
      if (l[t]){
        if (m._id){
          // console.log('updated to '+t+':'+m._id + ' for type ' + m.type);
          l[t][m.type] = m._id;
        }
      }
    });
  }

  if (reboot_required) {
    console.log('Got out of seq msg: ' + JSON.stringify(m));
    request_follow_in_10s();
  }
}



// DATASTORE

function ds (name, version, types, empty, self) {
  $.extend(self, {
    followed: {}, pending:{}, observers: {}, on_more_cb: function() {},

    get: function(on_more_cb){
      slices = self.track ? self.track() : everyone_and_me();
      self.on_more_cb = on_more_cb || refresh;
      if (!self.records) self.load();
      if (slices.some(function(s) { return !self.followed[s]; })) self.register(set_minus(slices, Object.keys(self.followed)));
      return self.records;
    },

    register: function(slices, db_latest_to_install){
      slices.forEach(function(slice){
        if (!self.followed[slice]) self.followed[slice] = true;
      });

      if (!db_latest_to_install){
        db_latest_to_install = {};
        slices.forEach(function(s){
          db_latest_to_install[s] = setify(types, null);
        });
      }

      please_follow(types, db_latest_to_install, function(msgs) {
        var accumulator = [];
        msgs.forEach(function(msg) {
          var obsoletes_msg = msg.supercedes && self.pending[msg.supercedes[0]];
          if (obsoletes_msg) delete self.pending[msg.supercedes[0]];
          guarded(function(){
            var effect = self.newmsg(msg, self.indexes, self.records, obsoletes_msg, accumulator);
            if (effect && effect.length == 3 && self.observers[effect[0]]){
              var o = self.observers[effect[0]];
              if (!o.going_to_run || !o.data){
                o.data = {};
                o.going_to_run = setTimeout(function(){ o(o.data); }, 10);
              }
              if (!o.data[effect[1]]) o.data[effect[1]] = [effect[2]];
              else o.data[effect[1]].push(effect[2]);
            }
          }, "Error in newmsg for " + name + " parsing " + JSON.stringify(msg));
        });
        self.on_more_cb(accumulator);
        self.store();
      }, self.world);
    },

    on: function(what, fn){ self.observers[what] = fn; },

    crosspost: function(x){
      var accumulator = [];
      guarded(function(){
        self.newmsg(x, self.indexes, self.records, null, accumulator);
      }, "Error in newmsg for " + name + " parsing " + JSON.stringify(x));
      self.on_more_cb(accumulator);
      self.store();
    },

    load: function() {
      var stored = localStorage.getItem(name);
      var db_latest_to_install = {};
      if (stored) stored = JSONparse(stored, 'ds/load');
      if (stored && stored.version == version){
        self.records = stored.records;
        self.followed = stored.followed || {};
        db_latest_to_install = stored.db_latest || {};
      } else {
        self.followed = {};
        self.records = JSON.parse(JSON.stringify(empty));
        if (self.one_time_install_data_hook) self.one_time_install_data_hook();  // TODO remove when we remove hardcoded ideas
      }
      self.indexes = {};
      self.cached_milestone = null;
      if (self.reindex) self.reindex(self.records, self.indexes);
      self.register(Object.keys(db_latest_to_install), db_latest_to_install);
      return;
    },

    clear: function(){
      clear_latest_of_types(types);
      localStorage.removeItem(name);
      self.load();
    },

    loaded: function(){
      if (!self.records) self.load();
      return self;
    },

    broken: function(){
      error_warning('Sorry, your internet is crappy. Some things aren\'t saving right and you\'ll have to try them again.');
      // self.clear();
    },

    post: function (params, cb){
      if (!self.records) self.load();
      var transient_msg = $.extend({ from: myid(), from_name: contact().name, updated_at: (Date.now()/1000), _id: "pending_" + Date.now() }, params);
      if (params.cc) transient_msg.to = transient_msg.to.concat(params.cc);
      params.supercedes = [transient_msg._id];
      params.user = JSON.stringify(user);
      for (var k in params){ if (!params[k]) delete params[k]; }
      // console.log('posting msg', params);
      $.ajax({
        url: SERVER+'/msgs',
        type:'POST',
        data:params,
        dataType: 'json',
        success:function(msg){
          if (cb) cb(msg._id);
        }
      });
      self.pending[transient_msg._id] = transient_msg;
      // console.log('newmsging', transient_msg);
      var accumulator = [];
      self.newmsg(transient_msg, self.indexes, self.records, false, accumulator);
      // console.log(name, self.on_more_cb);
      self.on_more_cb(accumulator);
      setTimeout(function() {
        if (self.pending[params._id]){
          self.broken();
          console.log('We didn\'t see the following message come back.');
          console.log(JSON.stringify(params));
        }
      }, 12000);
    },

    store: function (){
      if (self.store_pending) clearTimeout(self.store_pending);
      self.store_pending = setTimeout(function() {
        var json = JSON.stringify({version: version, records: (self.records || empty), db_latest: subobj(latest, types), followed:self.followed});
        try { localStorage.setItem(name, json); }
        catch(err){ console.log(err); }
      }, 3*1000);
    }
  });

  if (self.init_fn) self.init_fn(self);
  self.load();
  return self;
}







function collection (name, version, watch_fn, init_fn) {
  var self = {
    indexers: {}, buckets: null, cached_milestone: null,

    init_fn: init_fn,

    remove_obsolete: function(){
      if (!self.conserve_memory) return false;

      // remove any objects where we don't follow anything in to:
      values(self.records).forEach(function(r){
        if (!intersect(r.to, self.buckets).length) delete self.records[r.ID];
      });

      // destroy cached milestone and return true if we did
      self.cached_milestone = null;
      return true;
    },

    newmsg: function(x, indexes, records, replaces_transient) {
      self.cached_milestone = null;
      var x0 = records[x.ID], k;

      if (x.gone){
        var remaining_overlap = intersect(self.track(), x.still_in || []);
        if (remaining_overlap.length) return;
        delete records[x.ID];
        for (k in self.indexers){
          self.indexers[k](indexes[k], null, x0);
        }
        maybe_refresh();
        return;
      }

      if (self.decorator) self.decorator(x);

      records[x.ID] = x;

      for (k in self.indexers){
        self.indexers[k](indexes[k], x, x0);
      }

      if (window.maybe_refresh) maybe_refresh();
    },



    // done

    id: function(ID){
      self.get();
      return self.records[ID];
    },

    all: function(){
      self.get();
      return values(self.records);
    },

    delta: function(milestone){
      if (!milestone){
        return { added: Object.keys(self.records), new_buckets: self.track(), milestone: self.milestone() };
      }

      var cur_keys = Object.keys(self.records);
      var then_keys = Object.keys(milestone[1]);

      return {
        milestone: self.milestone(),
        added: set_minus(cur_keys, then_keys),
        removed: set_minus(then_keys, cur_keys),
        updated: cur_keys.filter(function(k){
          return milestone[1][k] != self.records[k]._id;
        }),
        new_buckets: set_minus(self.buckets, milestone[0]),
        gone_buckets: set_minus(milestone[0], self.buckets)
      };
    },

    milestone: function(){
      if (self.cached_milestone) return self.cached_milestone;
      var m = {};
      for (var k in self.records){
        m[k] = self.records[k]._id;
      }
      return self.cached_milestone = [self.buckets, m];
    },

    track: function(){
      // if (!self.buckets) 
      self.buckets = watch_fn();
      return self.buckets;
    },

    check: function(){
      var old_buckets, new_buckets;
      if (!self.buckets) old_buckets = [];
      else old_buckets = self.buckets;
      new_buckets = watch_fn();
      var lost = set_minus(old_buckets, new_buckets);
      var gained = set_minus(new_buckets, old_buckets);
      if (!lost.length && !gained.length) return;
      self.buckets = new_buckets;
      if (lost.length && self.remove_obsolete()) refresh();
      if (gained.length) self.get();
    },

    gen_id: function(){
      return '~' + gencode(16);
    },

    add: function(obj){
      obj.type = name;
      if (!obj.ID) obj.ID = self.gen_id(obj);
      // if (!obj.to) obj.to = self.default_to();
      return self.post(obj);
    },

    update: function(obj){ return self.post(obj); },
    rm: function(id){ return self.post({ID:id, type: name, to:[]}); },
    save: function(obj){ return self.add(obj); },

    reindex: function(records, indexes){
      for (var k in self.indexers){
        indexes[k] = {};
        for (var id in records){
          self.indexers[k](indexes[k], records[id]);
        }
      }
    },

    index_by: function(attr){
      self.indexers['by_' + attr] = function(index, x, x0){
        if (x && !x[attr]) return;
        if (x && !index[x[attr]]) index[x[attr]] = [];
        if (x0) delmatch_eq(index[x0[attr]], '_id', x0._id);
        if (x) index[x[attr]].push(x);
      };
    }

  };
  return ds(name, version, [name], {}, self);
}



// var intents = db('intent', '1.0.0');

// intents.indexers.by_idea = function(index, x, x0){
//   if (x && !index[x.idea]) index[x.idea] = [];
//   if (x0) delmatch_eq(index[x0.idea], '_id', x0._id);
//   if (x) index[x.idea].push(x);
// };




// db.watch({
//   is_still_on_screen_fn,
//   repaint_fn
// })
