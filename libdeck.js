// We've lacked a good social data model for do-ables.
//
// LibDeck is a plain-as-dirt representation scheme for tracking things that an individual or
// multiple people could do, possibly together or possibly apart, possibly specifying locations, timeframes or
// interdependencies, possibly with some network of supporting connections, like
// chatrooms, mentorships, etc.
//
// LibDeck is also an API and server framework for collaborating on sets of activities that
// conform to the model.
//
// Example applications go beyond todo lists and company task lists and include
// lists of favorite cafes, weekend planning for a group, foursquare venues,
// (do-able via checkin), project managements, complex team coordination, volunteer
// opportunities, etc.

// We've lacked a lightweight representation scheme for these
// things until now.

// Here are the basic concepts.

// # API

module.deck = function(){

// ## Idea
// A do-able.  *Representation:* a POJO of the form {title:"", ID:""}
// call Deck.idea({}) to turn a POJO into one with the following methods:

	var Idea = {
		type: 'idea',

		// ### state
		// do we have something going on with this idea already?
		state: function(){
			if (this.successes().length)              return 'done';
			if (this.confirmables().length)           return 'confirmable';
			if (this.plans().length)                  return 'plan';  // 'planned'
			if (this.invites().length)                return 'invited';
			if (this.interest().shared_with().length) return 'sugg';  // 'interested'
			return 'idea';  // 'inactive'
		},

		// ### interest
		// am I interested in doing it?
		interest: function(){
			var s = this.__.shouts.id(shout_id(this.__, this.ID));
			if (s && !last_2wks(s.updated_at)) s = null;
			return newobj(this.__, Interest, {
				idea: this,
				shout: s,
				when: s && s.t && s.t[0]
			});
		},

		// ### invites
		// has anyone invited me?
		invites: function(){
			var __ = this.__, self = this;
			__.shouts.get();
			var ss = __.shouts.indexes.by_orig[this.ID];
			if (!ss || !ss.length) return [];
			var plans = this.plans();

			return ss.filter(function(s){
				if (!last_2wks(s.updated_at)) return;
				if (s.from == __.myid()) return;
				if (plans.some(function(p){ return p.cohost() == s.from; })) return;
				return true;
			}).map(function(s){
				return newobj(__, Invite, { shout: s, idea: self });
			});
		},

		// ### plans
		// do I have plans for a certain day already?
		plans: function(){
			return compact(this.chatrooms().map(function(r){ return r.plan(); }));
		},

		// ### chatrooms
		// are we chatting about this idea with any groups?
		chatrooms: function(){
			var __ = this.__, self = this;
			__.chatrooms.get();
			var rooms = this.__.chatrooms.indexes.by_orig[this.ID];
			if (!rooms) return [];
			return sort_by(rooms, 'updated_at').map(function(r){
				if (!r.entries) r.entries = [];
				return newobj(__, Chatroom, { room: r, idea: self });
			});
		},

		// ### episodes
		// episodes can be chatrooms, invites, or interest
		// they have others(), chats(), ts(), timeframe(), path(), type

		episodes: function(){
			var episodes = this.chatrooms();
			var paths = setify(episodes.map(function(r){ return r.room.ID; }));
			var interest = this.interest();
			if (!this.plans().length && this.interest().shared_with().length && !paths[interest.path()]){
				episodes.push(interest);
			}
			this.invites().forEach(function(i){
				if (!paths[i.path()]) episodes.push(i);
			});
			return sort_by(episodes, function(x){ return x.ts(); });
		},

		// ### chatroom(who)
		// return a chatroom about this idea with those people in it
		chatroom: function(ID, who){
			var already;
			if (ID){
				already = this.chatrooms().filter(function(r){ return r.room.ID == ID; })[0];
				if (already) return already;
			} else {
				already = this.matching_chatroom(who);
				if (already) return already;
				ID = this.__.myid() + '_' + this.ID + '_' + (new Date().getTime() / 1000);
			}
			if (!who) return;
			return newobj(this.__, Chatroom, {
				idea: this,
				room: {
					ID: ID,
					to: uniq(who.concat([this.__.myid()])),
					orig: this.ID,
					ideas: [this.orig_idea],
					entries: []
				}
			});
		},

		// ### matching_chatroom(who)
		// return a chatroom about this idea with those people in it, if there's one
		matching_chatroom: function(who){
			var already = this.chatrooms().filter(function(r){
				return set_equal(r.room.to, who);
			})[0];
			if (already) return already;
		},

		// ### default_chatroom
		// the default chatroom for chatting right now about this idea
		default_chatroom: function(){
			var rooms = this.chatrooms();
			if (rooms.length) return rooms[0];
			var interest = this.interest();
			if (interest.shared()) return interest.chatroom();

			var invites = this.invites();
			if (invites.length != 1) return this.chatroom(null, [this.__.myid()]);
			return invites[0].chatroom();
		},

		// ### confirmables
		confirmables: function(){
			return [];
		},

		// ### successes
		successes: function(){
			return [];
		}
	};


	// ## Interests
	var Interest = {
		type: 'interest',
		path: function(){ return this.idea.ID + '/interest/' + this.__.myid(); },

		// ### shared?
		shared: function(){
			return this.shared_with().length;
		},

		// ### matching_chatroom
		matching_chatroom: function(){
			var already = this.idea.chatroom(this.path());
			if (already) return already;
			return this.idea.matching_chatroom([this.__.myid()].concat(this.shared_with()));
		},

		chats: function(){
			var room = this.matching_chatroom();
			return room ? room.chats() : [];
		},

		ts: function(){
			var chats = this.chats();
			if (!chats || !chats.length) return this.shout.updated_at;
			return Math.max(this.shout.updated_at, chats[chats.length-1].at);
		},

		// ### chatroom
		chatroom: function(){
			return this.matching_chatroom() || this.idea.chatroom(this.path(), [this.__.myid()].concat(this.shared_with()));
		},

		timeframe: function(tf){
			if (!tf) return this.shout && this.shout.t && this.shout.t[0];
			if (this.shout){
				this.shout.t = [tf];
				this.__.shouts.save(this.shout);
			} else {
				this.__.shouts.add({
					ID: shout_id(this.__, this.idea.pack, this.idea.ID),
					t: [tf],
					to: [this.__.myid()],
					pack: this.idea.pack,
					orig: this.idea.ID,
					ideas: [this.idea.orig_idea]
				});
			}
		},

		// ### share(who, when)
		share: function(who, r){
			who = [].concat(who);

			if (this.shout){
				var room = this.matching_chatroom();
				if (!set_minus(who, this.shout.to).length){
					if (!r || (this.shout.t && this.shout.t[0] == r)) return;
				}
				this.shout.to = uniq(this.shout.to.concat(who));
				if (r) this.shout.t = [r];
				this.__.shouts.save(this.shout);
				if (room) room.add(this.shout.to);
			} else {
				this.__.shouts.add({
					ID: shout_id(this.__, this.idea.pack, this.idea.ID),
					t: r && [r],
					to: who.concat([this.__.myid()]),
					pack: this.idea.pack,
					orig: this.idea.ID,
					ideas: [this.idea.orig_idea]
				});
			}

		},

		// ### shared_with
		shared_with: function(){
			if (!this.shout) return [];
			return set_minus(this.shout.to, [this.__.myid()]);
		},

		others: function(){
			return this.shared_with();
		},

		// ### link(for_who)
		link: function(who){
			var ID = shout_id(this.__, this.idea.pack, this.idea.ID);
			if (!this.shout) return "http://bright-ideas.co/m0_" + ID;
			var place = this.shout.to.indexOf(who);
			if (!~place) place = this.shout.to.length;
			return "http://bright-ideas.co/m" + place + "_" + ID;
		}
	};


	// ## Invites
	var Invite = {
		type: 'invite',

		// ### path
		path: function(){ return this.idea.ID + '/interest/' + this.shout.from; },

		others: function(){
			return [this.shout.from];
		},

		// ### chatroom
		chatroom: function(){
			var hosts = [this.__.myid(), this.shout.from];
			return this.idea.chatroom(this.path());
		},

		chats: function(){
			var room = this.chatroom();
			return room ? room.chats() : [];
		},

		ts: function(){
			var chats = this.chats();
			if (!chats || !chats.length) return this.shout.updated_at;
			return Math.max(this.shout.updated_at, chats[chats.length-1].at);
		},

		// ### timeframe
		timeframe: function(){
			return this.shout.t && this.shout.t[0];
		},

		// ### make_plan
		make_plan: function(){
			if (!this.timeframe()) return alert('Can\'t make a dayless invite into a plan');
			var r = this.chatroom();
			var hosts = [this.__.myid(), this.shout.from];
			r.room.plan = {
				hosts: hosts,
				from: this.__.myid(),
				when: this.timeframe()
			};
			this.__.chatrooms.save(r.room);
		}
	};


	// ## Plans
	// A kind of activity where a quorum of people have committed to doing it.  I.e., it's scheduled or whatever.
	var Plan = {
		type: 'plan',

		pairing: function(){
			return [ this.__.myid(), this.cohost() ].sort().join('-');
		},

		// ### path
		path: function(){
			return this.idea.ID + '/plan/' + this.pairing();
		},

		// ### cohost
		cohost: function(){
			return set_minus(this.plan.hosts, [this.__.myid()])[0];
		},

		timeframe: function(){
			return this.plan.when;
		},

		cancel: function(){ },
		success: function(){ }
	};

	// ## Chatrooms
	// A collection of chats about an idea or activity, visible to some group
	var Chatroom = {
		type: 'chatroom',

		path: function(){
			return this.room.ID;
		},

		others: function(){
			return set_minus(this.room.to, [this.__.myid()]);
		},

		chats: function(){
			return this.room.entries;
		},

		ts: function(){
			var chats = this.room.entries;
			if (!chats || !chats.length) return 0;
			return chats[chats.length-1].at;
		},

		timeframe: function(){
			var plan = this.plan();
			if (plan) return plan.timeframe();
		},

		// others(), chats(), day(), ts()

		plan: function(){
			if (this.room.plan) return newobj(this.__, Plan, {
				idea: this.idea,
				room: this,
				plan: this.room.plan
			});
		},

		// ### chatroom.invite (person => url)
		add: function(who_all){
			this.room.to = uniq(this.room.to.concat(who_all));
			this.__.chatrooms.save(this.room);
			// TODO, add an entry that says I invited them
		},

		// ### chatroom.post (msg)
		chat: function(msg){
			if (!msg || msg.match(/^\s*$/)) return;
			this.room.entries.push({
				from: this.__.myid(),
				msg: msg,
				at: (new Date().getTime() / 1000)
			});
			this.__.chatrooms.save(this.room);
		}
	};

	var Config = {
		init:function(){ this.idea_cache = {}; },
		myid: function(){ return this.uid || myid(); },

		idea:function(pack, obj){
			var clone = $.extend({}, obj);
			if (pack) clone.pack = pack;
			var clone2 = $.extend({}, clone);
			clone2.orig_idea = clone;
			return this.idea_cache[obj.ID] = newobj(this, Idea, clone2);
		},

		lookup: function(path){
			var parts = path.split('/');
			var idea = this.idea_cache[parts[0]];
			if (parts[1] == 'interest'){
				if (parts[2] == this.myid()) return idea.interest();
				return idea.invites().filter(function(i){
					return i.shout.from == parts[2];
				})[0];
			}
			else if (parts[1] == 'plan') return idea.plans().filter(function(i){
				return i.pairing() == parts[2];
			})[0];
		},

		all_invites: function(){
			var __ = this, ideas = [];
			__.shouts.get();
			for (var idea_id in __.shouts.indexes.by_orig){
				var shouts = __.shouts.indexes.by_orig[idea_id].filter(function(s){
					return s.from != __.myid();
				});
				if (shouts.length && shouts[0].ideas) ideas.push(__.idea(null, shouts[0].ideas[0]));
			}
			return flatten(ideas.map(function(x){ return x.invites(); }));
		},

		all_plans: function(){
			// simple: all chatrooms with plans that are in the future
			var __ = this, ideas = [];
			__.chatrooms.get();
			for (var idea_id in __.chatrooms.indexes.by_orig){
				var plans = __.chatrooms.indexes.by_orig[idea_id].filter(function(s){ return s.plan; });
				if (plans.length && plans[0].ideas) ideas.push(__.idea(null, plans[0].ideas[0]));
			}
			return flatten(ideas.map(function(x){ return x.plans(); }));
		}
	};

	function shout_id(__, stack_id, idea_id){
		return __.myid() + '_S_'  + (idea_id || stack_id);
	}

	function newobj(__, type, params){
		var o = $.extend(Object.create(type), params);
		o.__ = __;
		if (o.init) o.init();
		return o;
	}

	return {
		idea: function(pack, obj){ return this.default_config().idea(pack, obj); },
		lookup: function(path){ return this.default_config().lookup(path); },
		config: function(params){ return newobj(null, Config, params);},
		default_config: function(){
			if (this._default_config) return this._default_config;
			else return this._default_config = this.config({
				shouts: shouts,
				chatrooms: chatrooms
			});
		},

		all_plans:function(){ return this.default_config().all_plans(); },
		all_invites:function(){  return this.default_config().all_invites(); },
		all_successes:function(){}

	};
};



var shouts = collection('shout', 'v1.2', everyone_and_me, function(c){
	c.index_by('orig');
	c.index_by('pack');
	c.decorator = function(x){
		x.others = set_minus(x.to, [x.from]);
	};
});

var chatrooms = collection('chatroom', 'v1.0', just_me, function(c){
  c.index_by('orig');
});

var Deck = module('deck');
