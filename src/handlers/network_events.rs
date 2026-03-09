use crate::app::App;
use crate::db::{self, Database};
use crate::network::{ConnectionPool, NetworkEvent, NetworkMessage};
use chrono::Utc;
use std::net::SocketAddr;

/// Process a network event, updating both the app state and the database.
pub async fn handle_network_event(
    app: &mut App,
    database: &Database,
    pool: &ConnectionPool,
    _from: Option<SocketAddr>,
    event: NetworkEvent,
) {
    match event {
        NetworkEvent::MessageReceived { from: src, message } => {
            log::debug!("Message from {}: {:?}", src, std::mem::discriminant(&message));
            handle_message(app, database, pool, src, message).await;
        }
        NetworkEvent::ConnectionEstablished { peer_addr } => {
            log::info!("TCP connection established: {}", peer_addr);
        }
        NetworkEvent::ConnectionLost { peer_addr } => {
            log::info!("TCP connection lost: {}", peer_addr);
            let ip = peer_addr.ip().to_string();
            let conn = database.lock();
            for user in &mut app.users {
                if user.ip_address.as_deref() == Some(&ip) {
                    log::info!("Marking user '{}' ({}) as offline", user.display_name, user.id);
                    user.status = "offline".to_string();
                    let _ = db::update_user_status(
                        &conn,
                        &user.id,
                        "offline",
                        &Utc::now().to_rfc3339(),
                    );
                }
            }
        }
    }
}

async fn handle_message(
    app: &mut App,
    database: &Database,
    pool: &ConnectionPool,
    from: SocketAddr,
    message: NetworkMessage,
) {
    match message {
        NetworkMessage::Hello {
            user_id,
            username,
            display_name,
            port,
            ..
        } => {
            log::info!(
                "Received Hello from '{}' (id={}, addr={}:{})",
                username, user_id, from.ip(), port
            );
            let ip = from.ip().to_string();
            let conn = database.lock();

            // Upsert peer in DB
            let user = db::User {
                id: user_id.clone(),
                username: username.clone(),
                display_name: display_name.clone(),
                ip_address: Some(ip.clone()),
                port: Some(port as i64),
                status: "online".to_string(),
                last_seen: Some(Utc::now().to_rfc3339()),
                public_key: None,
            };
            let _ = db::upsert_user(&conn, &user);
            drop(conn);

            // Update app user list
            if let Some(u) = app.users.iter_mut().find(|u| u.id == user_id) {
                u.status = "online".to_string();
                u.display_name = display_name.clone();
                u.ip_address = Some(ip.clone());
            } else {
                app.users.push(db::User {
                    id: user_id.clone(),
                    username: username.clone(),
                    display_name: display_name.clone(),
                    ip_address: Some(ip.clone()),
                    port: Some(port as i64),
                    status: "online".to_string(),
                    last_seen: None,
                    public_key: None,
                });
            }
            app.status_message = format!("{} online peers", app.online_count());

            // Establish a reverse connection to the sender so we can send HelloAck
            // and future messages. The sender's LISTENING port comes from the Hello
            // message (not the ephemeral TCP source port).
            let peer_listen_addr = SocketAddr::new(from.ip(), port);
            match pool.get_or_connect(&user_id, peer_listen_addr).await {
                Ok(_) => {
                    log::info!("Reverse connection to {} established", peer_listen_addr);
                }
                Err(e) => {
                    log::warn!("Failed to establish reverse connection to {}: {}", peer_listen_addr, e);
                }
            }

            // Send HelloAck back through the pool (now has connection)
            let ack = NetworkMessage::HelloAck {
                user_id: app.my_user_id.clone(),
                username: app.my_username.clone(),
                display_name: app.my_username.clone(),
                port: app.port,
                public_key: vec![],
            };
            match pool.send_to(&user_id, &ack).await {
                Ok(_) => log::info!("Sent HelloAck to '{}'", username),
                Err(e) => log::warn!("Failed to send HelloAck to '{}': {}", username, e),
            }

            // Retry any undelivered messages for this peer
            retry_undelivered(app, database, pool, &user_id).await;
        }

        NetworkMessage::HelloAck {
            user_id,
            username,
            display_name,
            port,
            ..
        } => {
            log::info!(
                "Received HelloAck from '{}' (id={}, addr={}:{})",
                username, user_id, from.ip(), port
            );
            let ip = from.ip().to_string();
            let conn = database.lock();
            let user = db::User {
                id: user_id.clone(),
                username: username.clone(),
                display_name: display_name.clone(),
                ip_address: Some(ip.clone()),
                port: Some(port as i64),
                status: "online".to_string(),
                last_seen: Some(Utc::now().to_rfc3339()),
                public_key: None,
            };
            let _ = db::upsert_user(&conn, &user);
            drop(conn);

            // Ensure we have a connection to this peer in the pool
            let peer_listen_addr = SocketAddr::new(from.ip(), port);
            if let Err(e) = pool.get_or_connect(&user_id, peer_listen_addr).await {
                log::warn!("Failed to ensure connection to {} after HelloAck: {}", peer_listen_addr, e);
            }

            if let Some(u) = app.users.iter_mut().find(|u| u.id == user_id) {
                u.status = "online".to_string();
                u.display_name = display_name.clone();
                u.ip_address = Some(ip.clone());
            } else {
                app.users.push(db::User {
                    id: user_id,
                    username,
                    display_name,
                    ip_address: Some(ip),
                    port: Some(port as i64),
                    status: "online".to_string(),
                    last_seen: None,
                    public_key: None,
                });
            }
            app.status_message = format!("{} online peers", app.online_count());
        }

        NetworkMessage::ChatMessage {
            id,
            conversation_id,
            sender_id,
            content,
            content_type,
            timestamp,
        } => {
            log::info!(
                "Received ChatMessage id={} from={} conv={} content_type={}",
                id, sender_id, conversation_id, content_type
            );
            let conn = database.lock();

            // Ensure conversation exists locally
            if db::get_conversation_by_id(&conn, &conversation_id)
                .ok()
                .flatten()
                .is_none()
            {
                log::info!("Creating conversation {} for incoming message", conversation_id);
                let conv = db::Conversation {
                    id: conversation_id.clone(),
                    conv_type: "direct".to_string(),
                    name: None,
                    created_at: Utc::now().to_rfc3339(),
                };
                let _ = db::create_conversation(&conn, &conv);
                let _ = db::add_participant(&conn, &conversation_id, &app.my_user_id);
                let _ = db::add_participant(&conn, &conversation_id, &sender_id);
            }

            let msg = db::Message {
                id: id.clone(),
                conversation_id: conversation_id.clone(),
                sender_id: sender_id.clone(),
                content: content.clone(),
                content_type: content_type.clone(),
                timestamp: timestamp.clone(),
                delivered: true,
                read: false,
            };
            let _ = db::insert_message(&conn, &msg);
            drop(conn);

            // Send delivery receipt
            match pool
                .send_to(
                    &sender_id,
                    &NetworkMessage::MessageDelivered {
                        message_id: id.clone(),
                    },
                )
                .await
            {
                Ok(_) => log::debug!("Sent delivery receipt for msg {}", id),
                Err(e) => log::warn!("Failed to send delivery receipt for msg {}: {}", id, e),
            }

            // Show in UI if this conversation is open
            if app.selected_conversation.as_deref() == Some(&conversation_id) {
                app.messages.push(db::Message {
                    id,
                    conversation_id,
                    sender_id: sender_id.clone(),
                    content,
                    content_type,
                    timestamp,
                    delivered: true,
                    read: false,
                });
            } else {
                *app.unread_counts.entry(sender_id.clone()).or_insert(0) += 1;
                let name = app
                    .users
                    .iter()
                    .find(|u| u.id == sender_id)
                    .map(|u| u.display_name.clone())
                    .unwrap_or(sender_id);
                app.show_popup("New Message", &format!("Message from {}", name), Some(3.0));
            }
        }

        NetworkMessage::MessageDelivered { message_id } => {
            log::debug!("Message {} marked delivered", message_id);
            let conn = database.lock();
            let _ = db::mark_message_delivered(&conn, &message_id);
            // Update in-memory message
            if let Some(m) = app.messages.iter_mut().find(|m| m.id == message_id) {
                m.delivered = true;
            }
        }

        NetworkMessage::MessageRead {
            conversation_id,
            reader_id,
        } => {
            let conn = database.lock();
            let _ = db::mark_messages_read(&conn, &conversation_id, &reader_id);
            if app.selected_conversation.as_deref() == Some(&conversation_id) {
                for m in &mut app.messages {
                    m.read = true;
                }
            }
        }

        NetworkMessage::TypingIndicator {
            user_id,
            is_typing,
            ..
        } => {
            app.typing.insert(user_id, is_typing);
        }

        NetworkMessage::StatusUpdate { user_id, status } => {
            let conn = database.lock();
            let _ = db::update_user_status(
                &conn,
                &user_id,
                &status,
                &Utc::now().to_rfc3339(),
            );
            if let Some(u) = app.users.iter_mut().find(|u| u.id == user_id) {
                u.status = status;
            }
        }

        NetworkMessage::GroupCreate {
            conversation_id,
            name,
            creator_id,
            member_ids,
        } => {
            let conn = database.lock();
            let conv = db::Conversation {
                id: conversation_id.clone(),
                conv_type: "group".to_string(),
                name: Some(name.clone()),
                created_at: Utc::now().to_rfc3339(),
            };
            let _ = db::create_conversation(&conn, &conv);
            let _ = db::add_participant(&conn, &conversation_id, &app.my_user_id);
            for mid in &member_ids {
                let _ = db::add_participant(&conn, &conversation_id, mid);
            }
            drop(conn);

            // Add to local group list if not already present
            if !app.groups.iter().any(|g| g.id == conversation_id) {
                app.groups.push(db::Conversation {
                    id: conversation_id.clone(),
                    conv_type: "group".to_string(),
                    name: Some(name.clone()),
                    created_at: Utc::now().to_rfc3339(),
                });
            }
            app.show_popup(
                "New Group",
                &format!("{} created group '{}'", creator_id, name),
                Some(3.0),
            );
        }

        NetworkMessage::GroupInvite {
            conversation_id,
            inviter_id,
            invitee_id: _,
        } => {
            if !app.groups.iter().any(|g| g.id == conversation_id) {
                app.groups.push(db::Conversation {
                    id: conversation_id.clone(),
                    conv_type: "group".to_string(),
                    name: None,
                    created_at: Utc::now().to_rfc3339(),
                });
            }
            app.show_popup(
                "Group Invite",
                &format!("{} invited you to a group.", inviter_id),
                Some(3.0),
            );
        }

        NetworkMessage::Ping => {
            log::debug!("Received Ping from {}", from);
            // Respond with Pong — find peer by IP and send through pool
            let ip = from.ip().to_string();
            if let Some(peer) = app.users.iter().find(|u| u.ip_address.as_deref() == Some(&ip)) {
                let peer_id = peer.id.clone();
                let _ = pool.send_to(&peer_id, &NetworkMessage::Pong).await;
            } else {
                log::debug!("Ping from unknown peer {}, can't send Pong", from);
            }
        }

        NetworkMessage::Pong => {
            log::debug!("Received Pong from {}", from);
        }

        NetworkMessage::Goodbye { user_id } => {
            log::info!("Received Goodbye from {}", user_id);
            let conn = database.lock();
            let _ = db::update_user_status(
                &conn,
                &user_id,
                "offline",
                &Utc::now().to_rfc3339(),
            );
            if let Some(u) = app.users.iter_mut().find(|u| u.id == user_id) {
                u.status = "offline".to_string();
            }
            pool.remove(&user_id).await;
            app.status_message = format!("{} online peers", app.online_count());
        }

        other => {
            log::debug!("Unhandled message type from {}: {:?}", from, std::mem::discriminant(&other));
        }
    }
}

/// Retry any undelivered messages stored in the DB that were meant for `peer_id`.
async fn retry_undelivered(
    app: &mut App,
    database: &Database,
    pool: &ConnectionPool,
    peer_id: &str,
) {
    let undelivered = {
        let conn = database.lock();
        db::get_undelivered_messages(&conn, peer_id).unwrap_or_default()
    };

    if !undelivered.is_empty() {
        log::info!("Retrying {} undelivered messages for peer {}", undelivered.len(), peer_id);
    }

    for msg in undelivered {
        if msg.sender_id == app.my_user_id {
            let net_msg = NetworkMessage::ChatMessage {
                id: msg.id.clone(),
                conversation_id: msg.conversation_id.clone(),
                sender_id: msg.sender_id.clone(),
                content: msg.content.clone(),
                content_type: msg.content_type.clone(),
                timestamp: msg.timestamp.clone(),
            };
            if pool.send_to(peer_id, &net_msg).await.is_ok() {
                let conn = database.lock();
                let _ = db::mark_message_delivered(&conn, &msg.id);
                log::debug!("Retried message {} successfully", msg.id);
            }
        }
    }
}
