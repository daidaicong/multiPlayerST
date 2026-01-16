import { 
    saveChat, 
    addOneMessage, 
    scrollChatToBottom,
    chat,
    eventSource,
    event_types,
    characters,
    this_chid,
    converter,
    messageFormatting
} from "../../../script.js";

const WS_URL = "http://localhost:8001";
const MASTER_NICKNAME = "roomMaster";

let socket = null;
let isReady = false;
let isGenerating = false;
let myNickname = "";

// 定义一个唯一的存储 Key
const PROMPT_STORAGE_KEY = "coop_custom_fix_prompt"; 
// 尝试读取，如果没有则默认为空字符串或你想要的默认值
let g_fixAddPrompt = localStorage.getItem(PROMPT_STORAGE_KEY) || "";

// 1. 初始化插件
$(function () {
    // 加载配套 CSS
    $('<link>').attr({ rel: 'stylesheet', type: 'text/css', href: 'scripts/extensions/MultiUserChat/style.css' }).appendTo('head');
    
    injectHTML();
    loadSocketIO();
    //拖动
    makeDraggable($('#coop-panel'), $('.coop-title'));

    // 绑定连接按钮
    $(document).on('click', '#coop-connect-btn', function() {
        const inputName = String($('#coop-name-input').val() || "").trim();
        if (!inputName) {
            // @ts-ignore
            toastr.warning("请输入昵称");
            return;
        }
        myNickname = inputName;
        initWebSocket();
    });
    //绑定离开按钮
    $(document).on('click', '#coop-disconnect-btn', function() {
        if(socket){
            try {
                socket.disconnect();
            } catch(e) {
                serverDebug("Error disconnecting socket:" + e );
            }
        }
        isReady = false;
        isGenerating = false;
        myNickname = "";

        $('#coop-setup').show();    
        $('#coop-room').hide();
        $('#coop-indicator').text('🔴');
        $('#coop-player-list').empty();
        $('#coop-gen-info').text("");

        // 恢复正常的发送按钮行为
        const sendBtn = document.getElementById("send_but");
        const textarea = document.getElementById("send_textarea");
        if (sendBtn) {
            sendBtn.removeEventListener("click", coopClickHandler, { capture: true });
            // 恢复背景色
            sendBtn.style.background = ""; 
        }
        if (textarea) {
            textarea.removeEventListener("keydown", coopKeyHandler, { capture: true });
        }
        // 清空昵称输入框
        $('#coop-name-input').val('');
        // 恢复发送按钮背景色
        $("#send_but").css("background", "");
    });
    // 绑定固定追加提示词输入进缓存
    $(document).on('input', '#coop-infix-prompt', function() {
        const newVal = $(this).val();
        // 更新全局变量
        g_fixAddPrompt = newVal;
        // 存入浏览器本地存储
        localStorage.setItem(PROMPT_STORAGE_KEY, newVal);
        serverDebug("提示词已保存:" + newVal);
    });
    // 监听角色和预设变化，仅对主机生效,后续可增加更多变化的监听
    {
        eventSource.on(event_types.CHAT_CHANGED, function() 
        {
            if (myNickname === MASTER_NICKNAME) {
                // 延迟执行，确保状态已经更新
                setTimeout(() => {
                    onRequestState();
                }, 300);
            }
        });

        eventSource.on(event_types.PRESET_CHANGED, function() {
            if (myNickname === MASTER_NICKNAME) {
                // 延迟执行，确保状态已经更新
                setTimeout(() => {
                    onRequestState();
                }, 300);
            }
        });
    }
});

function loadSocketIO() {
    if (window['io']) return;
    const script = document.createElement('script');
    script.src = "https://cdn.socket.io/4.7.2/socket.io.min.js";
    document.head.appendChild(script);
}

function injectHTML() {
    const html = `
        <div id="coop-panel">
            <div class="coop-title"><span>👥 多人跑团</span><span id="coop-indicator">⚪</span></div>
            <div id="coop-setup">
                <input id="coop-name-input" placeholder="输入昵称..." />
                <button id="coop-connect-btn">加入房间</button>
            </div>
            <div id="coop-room" style="display:none">
                <div class="player-list" id="coop-player-list"></div>
                <div id="coop-gen-info" style="font-size:10px; margin-top:8px; opacity:0.6"></div>

                <!-- 新增设置界面 -->
                <div id="coop-settings">
                    <h3>设置 <span class="info-icon" title="追加提示词">?</span></h3>
                    <textarea id="coop-infix-prompt" placeholder="输入后缀提示词...">${g_fixAddPrompt}</textarea>
                </div>

                <button id="coop-disconnect-btn" class="disconnect-btn">退出房间</button>
            </div>
        </div>
    `;
    $('body').append(html);
}

// 2. WebSocket 与 拦截激活，绑定各种和服务端交互的回调函数
function initWebSocket() {
    // @ts-ignore
    socket = window['io'](WS_URL);

    socket.on("connect", () => {
        socket.emit("join", myNickname);
        $('#coop-setup').hide();
        $('#coop-room').show();
        $('#coop-indicator').text('🟢');
        // 【核心】连接后激活拦截
        activateInterception();
    },300);
    
    socket.on("update_room", (data) => {
        isGenerating = data.isGenerating;
        const $list = $('#coop-player-list').empty();
        data.players.forEach(p => {
            $list.append(`<div class="player-item"><span>${p.nickname}</span><span class="${p.isReady ? 'status-ready' : 'status-wait'}">${p.isReady ? 'READY' : '...'}</span></div>`);
        });
        $('#coop-gen-info').text(data.masterOnline ? "房主已在线" : "等待房主上线...");
    });

    socket.on("trigger_send", (data) => 
    {
        //serverDebug("触发发送消息"+myNickname + " : "+data);
        if (myNickname === MASTER_NICKNAME) {
            onRequestMetadata();
            handleMasterSend(data);
        }
        else{
            renderSendMessage(data);
        }
    });

    socket.on("stream_update", (data) => {
        if (myNickname !== MASTER_NICKNAME) renderStreamingMessage(data);
    });

    socket.on("request_master_state", () => {
        if (myNickname === MASTER_NICKNAME) onRequestState();
        //onRequestState发送状态给服务端
    });
    socket.on("sync_states", (state) => {
        //通常是客户端接受回调,主机不管
        if(myNickname !== MASTER_NICKNAME) onSyncMasterState(state);

    });


    socket.on("generation_finished", () => {
        isReady = false;

        $("#send_but").css("background", "");
        if (myNickname !== MASTER_NICKNAME) 
        {
            $("#send_textarea").val("").trigger("input");
            serverDebug("KEHU生成结束");
            eventSource.emit(event_types.MESSAGE_RECEIVED, chat.length - 1);
            //eventSource.emit(event_types.GENERATION_ENDED);
        }
        if(myNickname === MASTER_NICKNAME)
            saveChat();
    });
}


// 定义为命名函数，以便 removeEventListener 可以引用
function coopClickHandler(e) {
    if (myNickname === MASTER_NICKNAME) return;

    // 阻止事件继续传播，这样 ST 原生的 jQuery click 就永远收不到通知了
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (isGenerating) return;

    const text = String($("#send_textarea").val() || "").trim();
    if (!text && !isReady) return;

    isReady = !isReady;
    socket.emit("submit_ready", { text, isReady });
    
    // 更新 UI 状态
    $("#send_but").css("background", isReady ? "rgba(0, 255, 0, 0.4)" : "");
}

function coopKeyHandler(e) {
    if (myNickname === MASTER_NICKNAME) return;

    // 检查是否是 Enter 且无修饰键
    if (e.key === "Enter" && !e.ctrlKey && !e.shiftKey) {
        // 同样使用捕获阶段拦截
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        if (isGenerating) return;

        const text = String($("#send_textarea").val() || "").trim();
        if (!text && !isReady) return;

        isReady = !isReady;
        socket.emit("submit_ready", { text, isReady });
        $("#send_but").css("background", isReady ? "rgba(0, 255, 0, 0.4)" : "");
    }
}
// 拦截发送按钮和回车发送
function activateInterception() {
    if (myNickname === MASTER_NICKNAME) return;
    if (!myNickname) return;

    const sendBtn = document.getElementById("send_but");
    const textarea = document.getElementById("send_textarea");

    // 使用原生 addEventListener 并开启 capture: true
    // 这保证了它在任何 jQuery 事件（冒泡阶段）之前触发
    if (sendBtn) {
        sendBtn.addEventListener("click", coopClickHandler, { capture: true });
    }
    
    if (textarea) {
        textarea.addEventListener("keydown", coopKeyHandler, { capture: true });
    }
    
    //console.log("Coop interception activated (Capture Mode)");
}

/*获取房主的metadata，
 通知房主的，房主才会调用,玩家调用不生效
 */
function onRequestMetadata()
{
    // if(!myNickname) return;
    // if(myNickname !== MASTER_NICKNAME) return;

    // const context = SillyTavern.getContext();
    // //socket.emit("sync_metadata", context.chatMetadata);
    // serverDebug("发送metadata: " + context.chatMetadata);
}
/*获取房主前端当前角色卡，预设
 通知房主的，房主才会调用,玩家调用不生效
 */
function onRequestState()
{
    if(!myNickname) return;
    if(myNickname !== MASTER_NICKNAME) return;

    const context = SillyTavern.getContext();
    const presetManager = context.getPresetManager();
    const state = {
        characterId: context.characterId,
        presetName: presetManager.getSelectedPresetName(), 
        timestamp: Date.now()
    };
    socket.emit("sync_state", state);
}

// 消息处理
function handleMasterSend(prompt) {
    const roundId = "coop_" + Date.now(); // 生成本轮唯一的ID
    
    // 1. 发送指令
    $("#send_textarea").val(prompt + "\n<extraPromot> " + g_fixAddPrompt + " \n</extraPromot>").trigger("input");
    $("#send_but").trigger("click");

    let lastSentLength = 0; 

    // 2. 使用定时器轮询内部 chat 数组，而不是监听 DOM
    const streamSyncTimer = setInterval(() => {
        const lastMsg = chat[chat.length - 1];
        
        // 确保抓取的是 AI 正在生成的这条消息
        if (lastMsg && !lastMsg.is_user) {
            const currentRawText = lastMsg.mes; // 直接获取原始 Markdown 文本

            // 只有当内容长度增加时才发送，减少同步频率
            if (currentRawText && currentRawText.length > lastSentLength) {
                lastSentLength = currentRawText.length;
                
                socket.emit("stream_data", { 
                    roundId: roundId, 
                    fullText: currentRawText 
                });
            }
        }

        // 3. 停止判定：当发送按钮重新变为可见，且没有停止按钮时
        if ($("#send_but").is(":visible") && !$(".st-stop-button").length) {
            socket.emit("stream_end");
            clearInterval(streamSyncTimer);
            console.log("[Coop] 本轮流式传输结束");
        }
    }, 400); // 400ms 同步一次，非常丝滑
}

// 在全局定义一个变量记录当前正在处理的消息楼层 ID
let lastProcessedRoundId = null;
// 玩家收到房主分发的AI消息，重绘
function renderStreamingMessage(data) {
    const { roundId, fullText } = data;
    //serverDebug(data);
    if (lastProcessedRoundId === roundId) {
        // --- A. 更新模式：找到刚才那层楼，换掉文字 ---
        // 1. 更新内存数据
        const lastIdx = chat.length - 1;
        chat[lastIdx].mes = fullText;
        chat[lastIdx].swipes[0] = fullText; // 【MVU修复】同步更新 swipe
        chat[lastIdx].send_date = getNowStr();
        // 2. 更新 UI
        // 找到最后一条带 coop 标记的消息文本框
        const $targetMsg = $(".mes[data-coop-id='" + roundId + "']").find(".mes_text");
        
        if ($targetMsg.length > 0) {
            // 使用 ST 内置的 Markdown 渲染器（如果有的话）或者直接填入文本
            // 如果你希望玩家端也能美化，可以调用 ST 的渲染函数：
            const characterName = characters[this_chid]?.name || "AI";
            const formattedContent = messageFormatting(fullText, characterName, false, false, lastIdx);
            $targetMsg.html(formattedContent);
            //eventSource.emit(event_types.MESSAGE_UPDATED, lastIdx);
            // $targetMsg.text(fullText); 
        }

    } else {
        // --- B. 新建模式：第一次收到这个 ID 的数据 ---
        lastProcessedRoundId = roundId;

        const characterName = characters[this_chid]?.name || "AI";
        const formattedContent = messageFormatting(fullText, characterName, false, false, chat.length);
        const aiMessage = {
            name: characterName,
            is_user: false,
            is_system: false,
            send_date: getNowStr(), // 【MVU修复】
            mes: formattedContent, // 这里存格式化后的文本，但在 swipes 里通常存原始文本
            swipes: [fullText],    // 【MVU修复】存原始文本
            swipe_id: 0,
            extra: { 
                is_coop: true, 
                type: 'coop_ai_response' 
            }
        };

        chat.push(aiMessage);
        addOneMessage(aiMessage); // ST 的原生函数

        //eventSource.emit(event_types.MESSAGE_RECEIVED, chat.length-1, 'coop');
        // 给新创建的 DOM 元素打上 ID 标记，方便下次查找
        $(".mes").last().attr("data-coop-id", roundId);
    }

    scrollChatToBottom();
}

// 玩家收到房主发来的"共同发送消息"，重绘
function renderSendMessage(data) 
{
    // 添加玩家联合输入的消息
    const playersPromot = data + "\n<extraPromot> " + g_fixAddPrompt + " \n</extraPromot>"
    //serverDebug("Hoke: " + playersPromot);
    const combinedUserMessage = {
        name: "Players", // 如果想显示具体名字，需要从服务端传过来
        is_user: true,
        is_system: false,
        send_date: getNowStr(), // 【MVU修复】必须有时间
        mes: playersPromot,
        swipes: [playersPromot], // 【MVU修复】swipes 数组用于支持多重回复
        swipe_id: 0,
        extra: { 
            is_coop: true, 
            type: 'coop_user_input' 
        }
    };

    chat.push(combinedUserMessage);
    addOneMessage(combinedUserMessage); 
    eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, chat.length-1);
    scrollChatToBottom();
}

/**
 * 同步主节点状态到当前客户端，只有客户端会调用
 * 该函数负责根据主节点传来的状态信息，更新当前客户端的角色和预设设置
 * 
 * state - 包含同步状态的对象
 * state.characterId - 要切换到的角色ID
 * state.presetName - 要切换到的预设名称
 */
function onSyncMasterState(state)
{
    const context = SillyTavern.getContext();
    // 检查是否已经是该角色，避免重复加载
    serverDebug("test");
    if (context.characterId !== state.characterId && state.characterId) {
        context.selectCharacterById(state.characterId);
    }
    
    serverDebug(state.presetName);
    //JQuery 选择器
    const $select = $('#settings_preset_openai');
    const targetName = state.presetName;
    // 检查下拉框是否存在
    if ($select.length === 0) {
        serverDebug("错误：找不到 #settings_preset_openai 下拉框");
        return;
    }
    // 遍历选项，按"文字内容"匹配
    const $option = $select.find('option').filter(function() {
        return $(this).text().trim() === targetName.trim();
    });

    if ($option.length > 0) {
        const val = $option.val();
        // 选中并触发酒馆原生的切换逻辑
        $select.val(val).trigger('change');
        serverDebug(`同步成功：已切换对话预设至 [${targetName}]`);
    } else {
        // 如果找不到，打印当前前 5 个选项，帮你排查是否存在名称差异
        const available = $select.find('option').slice(0, 5).map((i, el) => $(el).text()).get();
        serverDebug(`同步失败 Slave 端没找到预设 [${targetName}]。当前可用示例: ${available.join(', ')}`);
    }
}


//拖动插件的UI，小功能
/**
 * 通用拖拽函数
 * @param {JQuery} $panel - 整个悬浮窗对象
 * @param {JQuery} $handle - 拖动把手（标题栏）
 */
function makeDraggable($panel, $handle) {
    let isDragging = false;
    let offset = { x: 0, y: 0 };

    $handle.on('mousedown', function (e) {
        isDragging = true;
        // 计算鼠标相对面板左上角的偏移
        const panelOffset = $panel.offset();
        offset.x = e.pageX - panelOffset.left;
        offset.y = e.pageY - panelOffset.top;
        
        $panel.css('opacity', '0.8'); // 拖动时增加透明度反馈
    });

    $(window).on('mousemove', function (e) {
        if (!isDragging) return;

        // 计算新位置
        let newX = e.pageX - offset.x;
        let newY = e.pageY - offset.y;

        // 简单的边界限制（防止拖出屏幕外）
        newX = Math.max(0, Math.min(window.innerWidth - $panel.outerWidth(), newX));
        newY = Math.max(0, Math.min(window.innerHeight - $panel.outerHeight(), newY));

        $panel.css({
            left: newX + 'px',
            top: newY + 'px',
            right: 'auto' // 取消之前的 right: 20px 限制
        });
    });

    $(window).on('mouseup', function () {
        if (isDragging) {
            isDragging = false;
            $panel.css('opacity', '1');
            
            // 可选：将位置保存到 localStorage
            const pos = { top: $panel.css('top'), left: $panel.css('left') };
            localStorage.setItem('coop-panel-pos', JSON.stringify(pos));
        }
    });

    // 初始位置恢复（如果之前保存过）
    const savedPos = localStorage.getItem('coop-panel-pos');
    if (savedPos) {
        const { top, left } = JSON.parse(savedPos);
        $panel.css({ top, left, right: 'auto' });
    }
}
function serverDebug(info)
{
    socket.emit("debug", info);
}
// 获取当前时间戳的辅助函数
function getNowStr() {
    return new Date().toLocaleString();
}