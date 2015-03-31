(function() {
'use strict';

var weechat = angular.module('weechat');
/*
            <tr class="bufferline">
              <td class="time">
                <span class="date" ng-class="::{'repeated-time': bufferline.shortTime==bufferlines[$index-1].shortTime}">
                  <span class="cof-chat_time cob-chat_time coa-chat_time" ng-bind="::(bufferline.date|date:'HH')"></span><span class="cof-chat_time_delimiters cob-chat_time_delimiters coa-chat_time_delimiters">:</span><span class="cof-chat_time cob-chat_time coa-chat_time" ng-bind="::(bufferline.date|date:'mm')"></span><span class="seconds"><span class="cof-chat_time_delimiters cob-chat_time_delimiters coa-chat_time_delimiters">:</span><span class="cof-chat_time cob-chat_time coa-chat_time" ng-bind="::(bufferline.date|date:'ss')"></span></span>
                </span>
              </td>
              <td class="prefix"><a ng-click="addMention(bufferline.prefix)"><span ng-repeat="part in ::bufferline.prefix" ng-class="::part.classes" ng-bind="::part.text|prefixlimit:25"></span></a></td><!--
           --><td class="message"><!--
             --><div ng-repeat="metadata in ::bufferline.metadata" plugin data="::metadata"></div><!--
             --><span ng-repeat="part in ::bufferline.content" class="text" ng-class="::part.classes.concat(['line-' + part.$$hashKey.replace(':','_')])" ng-bind-html="::part.text | linky:'_blank' | DOMfilter:'irclinky' | DOMfilter:'emojify':settings.enableJSEmoji | DOMfilter:'inlinecolour' | DOMfilter:'mathjax':('.line-' + part.$$hashKey.replace(':','_')):settings.enableMathjax"></span>
              </td>
            </tr>
            <tr class="readmarker" ng-if="activeBuffer().lastSeen==$index">
              <td colspan="3">
                <hr id="readmarker">
              </td>
            </tr>
          </tbody>
*/


weechat.directive('bufferLines', function() {
    return {
        scope:{
            bufferlines:'='
        },
        controller: ['$rootScope', '$filter', '$compile', '$scope', 'settings', function($rootScope, $filter, $compile, $scope, settings) {

 $scope.Time = React.createClass({
    render: function() {
        return (
            React.DOM.td({className:'time'},
                React.DOM.span({className:'cof-chat_time cob-chat_time coa-chat_time'}, $filter('date')(this.props.bufferline.date, 'HH')),
                React.DOM.span({className:'cof-chat_time_delimiters cob-chat_time_delimiters coa-chat_time_delimiters'}, ':'),
                React.DOM.span({className:'cof-chat_time cob-chat_time coa-chat_time'}, $filter('date')(this.props.bufferline.date, 'mm')),
                React.DOM.span({className:'seconds'},
                    React.DOM.span({className:'cof-chat_time_delimiters cob-chat_time_delimiters coa-chat_time_delimiters'}, ':'),
                    React.DOM.span({className:'cof-chat_time cob-chat_time coa-chat_time'}, $filter('date')(this.props.bufferline.date, 'ss'))
                )
            )
        )
    }
});
$scope.Prefix = React.createClass({
    render: function() {
        var parts = this.props.bufferline.prefix.map(function(part) {
            return React.DOM.span({className: part.classes.join(' ')}, part.text);
        });
        return (
            React.DOM.td({className:'prefix'}, parts)
        )
    }
});
$scope.Message = React.createClass({
    render: function() {
        var pluginparts = this.props.bufferline.metadata.map(function(part, idx) {
            var childScope = $scope.$new();
            childScope.metadata = part;
            part.$$hashKey = toString(idx);
            var compiledDirective = $compile('<div plugin data="metadata"></div>');
            var directiveElement = compiledDirective(childScope);
            console.log(directiveElement);
            //FIXME
            return React.DOM.div({dangerouslySetInnerHTML: {__html:directiveElement[0].innerHTML}});
        });
        var parts = this.props.bufferline.content.map(function(part, idx) {
            var f = $filter;
            var html = f('DOMfilter')(f('linky')(part.text, '_blank'), 'irclinky');
            html = f('DOMfilter')(html, 'inlinecolour');
            if (settings.enableJSEmoji) {
                html = f('DOMfilter')(html, 'inlinecolour');
            }
            if (settings.enableMathjax) {
                html = f('DOMfilter')('.line-' + idx, 'mathjax');
            }
            var span = React.DOM.span({className: part.classes.concat(['line-' + idx, 'text']).join(' '), dangerouslySetInnerHTML: {__html:html}});
            return span;
        });
        return (
            React.DOM.td({className:'message'}, pluginparts, parts)
        )
    }
});
$scope.BufferLine = React.createClass({
    render: function() {
        return (
            React.DOM.tr({className:'bufferline'},
                React.createElement($scope.Time, {bufferline:this.props.bufferline}),
                React.createElement($scope.Prefix, {bufferline:this.props.bufferline}),
                React.createElement($scope.Message, {bufferline:this.props.bufferline})
            )
        )
    }
});
$scope.ReadMarker = React.createClass({
    render: function() {
        return (
            React.DOM.tr({className:'readmarker'},
                React.DOM.td({colSpan:3},
                    React.DOM.hr({id:'readmarker'}, null)
                )
            )
        )
    }
});
$scope.BufferLines = React.createClass({
    render: function() {
        console.log('render', this, this.props.buffer);
        var lastSeen = this.props.buffer.lastSeen;
        var rows = this.props.bufferlines.map(function(bufferline, i) {
            if (lastSeen === i) {
                return React.createElement($scope.ReadMarker);
            }
            return React.createElement($scope.BufferLine, {bufferline:bufferline});
        })
        return (
            React.DOM.tbody(null,
                rows
            )
        );
    }
});
        }],
        link:function(scope, el, attrs){
            scope.$watchCollection('bufferlines', function(newValue, oldValue){
                React.render(
                    React.createElement(scope.BufferLines, {bufferlines:newValue,buffer:scope.$parent.activeBuffer()}),
                    el[0],
                    function() {
                        console.log('rendered');
                        scope.$root.updateBufferBottom(true);
                        scope.$root.scrollWithBuffer(true);
                    }
                );
            })
        }
    }
})

})();
