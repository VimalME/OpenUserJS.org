var fs = require('fs');
var formidable = require('formidable');
var async = require('async');

var Discussion = require('../models/discussion').Discussion;
var Flag = require('../models/flag').Flag;
var Group = require('../models/group').Group;
var Script = require('../models/script').Script;
var User = require('../models/user').User;
var Vote = require('../models/vote').Vote;

var scriptStorage = require('./scriptStorage');
var addScriptToGroups = require('./group').addScriptToGroups
var flagLib = require('../libs/flag');
var removeLib = require('../libs/remove');
var modelsList = require('../libs/modelsList');
var modelParser = require('../libs/modelParser');
var renderMd = require('../libs/markdown').renderMd;
var formatDate = require('../libs/helpers').formatDate;

// Let script controllers know this is a lib route
exports.lib = function (controller) {
  return (function (req, res, next) {
    req.route.params.isLib = true;
    controller(req, res, next);
  });
};

// Display which scripts use a library hosted on the site
exports.useLib = function (req, res, next) {
  var installName = req.route.params.shift().toLowerCase() + '/' 
    + req.route.params.shift();
  var user = req.session.user;
  var options = { username: user ? user.name : '' };

  Script.findOne({ installName: installName + '.js' }, function (err, lib) {
    if (err || !lib) { return next(); }

    options.title = 'Scripts that use <a href="/libs/' + installName + '">' 
      + lib.name + '</a>';
    modelsList.listScripts({ uses: lib.installName },
      req.route.params, '/use/lib/' + installName,
      function (scriptsList) {
        options.scriptsList = scriptsList;
        res.render('group', options);
    });
  });
};

// View a detailed description of a script
// This is the most intensive page to render on the site
exports.view = function (req, res, next) {
  var user = req.session.user;

  var installName = scriptStorage.getInstallName(req);
  var scriptAuthor = req.route.params.username;
  var scriptNameSlug = req.route.params.scriptname;
  var isLib = req.route.params.isLib;

  Script.findOne({
    installName: installName + (isLib ? '.js' : '.user.js')
  }, function (err, scriptData) {
    if (err || !scriptData) { return next(); }

    var options = {};
    var tasks = [];

    //
    options.title = scriptData.name + ' | OpenUserJS.org';
    options.user = user;

    //
    var script = options.script = modelParser.parseScript(scriptData);
    options.script.isOwner = options.user && options.user._id == script._authorId,
    options.script.aboutRendered = renderMd(script.about);

    var fork = script.fork;
    // Set the forks to be label properly
    if (fork instanceof Array && fork.length > 0) {
      fork[0].first = true;
      fork[fork.length - 1].original = true;
    } else {
      fork = null;
    }

    // Show the number of open issues
    tasks.push(function (callback) {
      var category = (script.isLib ? 'libs' : 'scripts') + '/' + installName;
      options.scriptIssuesPageUrl = '/' + category + '/issues';
      options.scriptOpenIssuePageUrl = '/' + category + '/issue/new';

      Discussion.count({ category: category + '/issues', open: true },
        function (err, count) {
          if (err) { count = 0; }
          options.issuesCount = count;
          callback();
      });
    });

    // Show collaborators of the script
    if (script.meta.author && script.meta.collaborator) {
      options.hasCollab = true;
      if (typeof script.meta.collaborator === 'string') {
        options.collaborators = [{ name: script.meta.collaborator }];
      } else {
        script.meta.collaborator.forEach(function (collaborator) {
          options.collaborators.push({ name: collaborator });
        });
      }
    }

    // Show the groups the script belongs to
    tasks.push(function (callback) {
      if (script.isLib) { return callback(); }

      Group.find({ _scriptIds: script._id }, 'name', function (err, groups) {
        options.hasGroups = !err && groups.length > 0;
        options.groups = (groups || []).map(function (group) {
          return { name: group.name, url: group.name.replace(/\s+/g, '_') };
        });
        callback();
      });
    });

    // Show which libraries hosted on the site a script uses
    if (!script.isLib && script.uses && script.uses.length > 0) {
      options.usesLibs = true;
      options.libs = [];
      tasks.push(function (callback) {
        Script.find({ installName: { $in: script.uses } },
          function (err, libs) {
            libs.forEach(function (lib) {
              options.libs.push({ 
                name: lib.name, url: lib.installName.replace(/\.js$/, '') 
              });
            });
            callback();
        });
      });
    } else if (script.isLib) {
      // Show how many scripts use this library
      tasks.push(function (callback) {
        Script.count({ uses: script.installName }, function (err, count) {
          if (err) { count = 0; }
          if (count <= 0) { return callback(); }

          options.usedBy = { count: count, url: '/use/lib/' + installName };
          if (count > 1) { options.usedBy.multiple = true; }

          callback();
        });
      });
    }

    // Setup the voting UI
    tasks.push(function (callback) {
      var voteUrl = scriptData.url + '/vote/';
      options.voteUpUrl = voteUrl + 'up';
      options.voteDownUrl = voteUrl + 'down';

      options.voteable = false;
      options.votedUp = false;
      options.votedDown = false;

      // Can't vote when not logged in or when user owns the script.
      if (!user || options.isOwner) {
        callback();
        return;
      }

      Vote.findOne({
        _scriptId: scriptData._id,
        _userId: user._id
      }, function (err, voteModel) {
        options.voteable = !options.script.isOwner;

        if (voteModel) {
          if (voteModel.vote) {
            options.votedUp = true;
            options.voteUpUrl = voteUrl + 'unvote';
          } else {
            options.votedDown = true;
            options.voteDownUrl = voteUrl + 'unvote';
          }
        }

        callback();
      });

    });

    // Setup the flagging UI
    tasks.push(function (callback) {
      var flagUrl = '/flag' + (script.isLib ? '/libs/' : '/scripts/') + installName;

      // Can't flag when not logged in or when user owns the script.
      if (!user || options.isOwner) {
        callback();
        return;
      }

      flagLib.flaggable(Script, script, user,
        function (canFlag, author, flag) {
          if (flag) {
            flagUrl += '/unflag';
            options.flagged = true;
            options.flaggable = true;
          } else {
            options.flaggable = canFlag;
          }
          options.flagUrl = flagUrl;

          callback();
      });
    });

    // Set up the removal UI
    tasks.push(function (callback) {
      // Can't remove when not logged in or when user owns the script.
      if (!user || options.isOwner) {
        callback();
        return;
      }

      removeLib.removeable(Script, script, user,
        function (canRemove, author) {
          options.moderation = canRemove;
          options.flags = script.flags || 0;
          options.removeUrl = '/remove' + (script.isLib ? '/libs/' : '/scripts/') + installName;

          if (!canRemove) { return callback(); }

          flagLib.getThreshold(Script, script, author,
            function (threshold) {
              options.threshold = threshold;
              callback();
          });
      });
    });

    function render(){ res.render('pages/scriptPage', options); }
    async.parallel(tasks, render);
  });
};

// route to edit a script
exports.edit = function (req, res, next) {
  var installName = null;
  var isLib = req.route.params.isLib;
  var user = req.session.user;

  if (!user) { return res.redirect('/login'); }

  req.route.params.username = user.name.toLowerCase();
  installName = scriptStorage.getInstallName(req);

  Script.findOne({ installName: installName + (isLib ? '.js' : '.user.js') },
    function (err, script) {
      var baseUrl = script && script.isLib ? '/libs/' : '/scripts/';
      if (err || !script || script._authorId != user._id) { return next(); }

      if (typeof req.body.about !== 'undefined') {
        if (req.body.remove) {
          scriptStorage.deleteScript(script.installName, function () {
            res.redirect('/users/' + encodeURI(user.name));
          });
        } else {
          script.about = req.body.about;
          addScriptToGroups(script, req.body.groups.split(/,/), function () {
            res.redirect(encodeURI(baseUrl + installName));
          });
        }
      } else {
        Group.find({ _scriptIds: script._id }, 'name', function (err, groups) {
          var groupsArr = (groups || []).map(function (group) {
            return group.name;
          });

          res.render('scriptEdit', {
            title: script.name,
            name: script.name,
            install: (script.isLib ? '/libs/src/' : '/install/')
              + script.installName,
            source: baseUrl + installName + '/source',
            about: script.about,
            groups: JSON.stringify(groupsArr),
            canCreateGroup: (!script._groupId).toString(),
            isLib: script.isLib,
            username: user ? user.name : null
          });
        });
      }
  });
};

// Script voting
exports.vote = function (req, res, next) {
  var isLib = req.route.params.isLib;
  var installName = scriptStorage.getInstallName(req)
    + (isLib ? '.js' : '.user.js');
  var vote = req.route.params.vote;
  var user = req.session.user;
  var url = req._parsedUrl.pathname.split('/');
  var unvote = false;

  if (!user) { return res.redirect('/login'); }
  if (url.length > 5) { url.pop(); }
  url.shift();
  url.shift();
  url = '/' + url.join('/');
  url = encodeURI(url);

  if (vote === 'up') {
    vote = true;
  } else if (vote === 'down') {
    vote = false;
  } else if (vote === 'unvote') {
    unvote = true;
  } else {
    return res.redirect(url);
  }

  Script.findOne({ installName: installName },
    function (err, script) {
      if (err || !script) { return res.redirect(url); }

      Vote.findOne({ _scriptId: script._id, _userId: user._id },
        function (err, voteModel) {
          var oldVote = null;
          var votes = script.votes || 0;
          var flags = 0;

          function saveScript () {
            if (!flags) {
              return script.save(function (err, script) { res.redirect(url); });
            }

            flagLib.getAuthor(script, function(author) {
              flagLib.saveContent(Script, script, author, flags,
                function (flagged) {
                  res.redirect(url);
              });
            });
          }

          if (!script.rating) { script.rating = 0; }
          if (!script.votes) { script.votes = 0; }

          if (user._id == script._authorId || (!voteModel && unvote)) {
            return res.redirect(url);
          } else if (!voteModel) {
            voteModel = new Vote({ 
              vote: vote,
              _scriptId: script._id,
              _userId: user._id
            });
            script.rating += vote ? 1 : -1;
            script.votes = votes + 1;
            if (vote) { flags = -1; }
          } else if (unvote) {
            oldVote = voteModel.vote;
            return voteModel.remove(function () {
              script.rating += oldVote ? -1 : 1;
              script.votes = votes <= 0 ? 0 : votes - 1;
              if (oldVote) { flags = 1; }
              saveScript();
            });
          } else if (voteModel.vote !== vote) {
            voteModel.vote = vote;
            script.rating += vote ? 2 : -2;
            flags = vote ? -1 : 1;
          }

          voteModel.save(saveScript);
      });
  });
};

// Script flagging
exports.flag = function (req, res, next) {
  var isLib = req.route.params.isLib;
  var installName = scriptStorage.getInstallName(req);
  var unflag = req.route.params.unflag;

  Script.findOne({ installName: installName + (isLib ? '.js' : '.user.js') },
    function (err, script) {
      var fn = flagLib[unflag && unflag === 'unflag' ? 'unflag' : 'flag'];
      if (err || !script) { return next(); }

      fn(Script, script, req.session.user, function (flagged) {
        res.redirect((isLib ? '/libs/' : '/scripts/') + encodeURI(installName));
      });
  });
};
