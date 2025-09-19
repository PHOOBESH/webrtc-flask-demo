# --- suppress tensorflow / mediapipe logs ---
import os
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'

import cv2
import mediapipe as mp
import numpy as np
from collections import deque

# ---------- SETTINGS ----------
CAM_INDEX = 0
CLOSE_EYE_THRESHOLD = 0.22
FPS = 30  # approximate webcam fps
BAR_MAX_WIDTH = 300  # pixels
BAR_HEIGHT = 20
# ------------------------------

mp_face_mesh = mp.solutions.face_mesh
mp_drawing = mp.solutions.drawing_utils

# Eye landmark indices for EAR
LEFT_EYE_INDICES = [33, 160, 158, 133, 153, 144]
RIGHT_EYE_INDICES = [362, 385, 387, 263, 373, 380]

# Iris indices
LEFT_IRIS = [468, 469, 470, 471]
RIGHT_IRIS = [473, 474, 475, 476]

# Buffers for smoothing
ear_history = deque(maxlen=5)
att_history = deque(maxlen=10)

# Micro-sleep detection
eyes_closed_frames = 0

# For head pose estimation (using solvePnP)
# 3D model points of some key landmarks
model_points = np.array([
    (0.0, 0.0, 0.0),            # Nose tip
    (-30.0, -125.0, -30.0),     # Chin
    (-60.0, 40.0, -60.0),       # Left eye corner
    (60.0, 40.0, -60.0),        # Right eye corner
    (-40.0, -40.0, -60.0),      # Left mouth corner
    (40.0, -40.0, -60.0)        # Right mouth corner
], dtype=np.float64)

# Landmarks indices corresponding to model points
landmark_ids = [1, 152, 33, 263, 61, 291]


def eye_aspect_ratio(landmarks, indices, w, h):
    pts = [(int(landmarks[i].x * w), int(landmarks[i].y * h)) for i in indices]
    A = np.linalg.norm(np.array(pts[1]) - np.array(pts[5]))
    B = np.linalg.norm(np.array(pts[2]) - np.array(pts[4]))
    C = np.linalg.norm(np.array(pts[0]) - np.array(pts[3]))
    ear = (A + B) / (2.0 * C)
    return ear


cap = cv2.VideoCapture(CAM_INDEX)

with mp_face_mesh.FaceMesh(
        max_num_faces=1,
        refine_landmarks=True,
        min_detection_confidence=0.6,
        min_tracking_confidence=0.6) as face_mesh:

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            print("No frame received. Check camera index.")
            break

        frame = cv2.flip(frame, 1)
        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = face_mesh.process(rgb_frame)

        attention_score = 0.0

        if results.multi_face_landmarks:
            face_landmarks = results.multi_face_landmarks[0]
            h, w, _ = frame.shape

            # Draw landmarks
            mp_drawing.draw_landmarks(
                frame, face_landmarks, mp_face_mesh.FACEMESH_CONTOURS,
                mp_drawing.DrawingSpec(color=(0, 255, 0), thickness=1, circle_radius=1),
                mp_drawing.DrawingSpec(color=(0, 0, 255), thickness=1))

            # ---------------- EYE OPENNESS ----------------
            left_ear = eye_aspect_ratio(face_landmarks.landmark, LEFT_EYE_INDICES, w, h)
            right_ear = eye_aspect_ratio(face_landmarks.landmark, RIGHT_EYE_INDICES, w, h)
            avg_ear = (left_ear + right_ear) / 2.0
            ear_history.append(avg_ear)
            smooth_ear = sum(ear_history) / len(ear_history)

            if smooth_ear < CLOSE_EYE_THRESHOLD:
                eyes_closed_frames += 1
                eye_openness_score = 0.0
                cv2.putText(frame, "Eyes Closed", (30, 80),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)
            else:
                eyes_closed_frames = 0
                eye_openness_score = min(1.0, (smooth_ear - CLOSE_EYE_THRESHOLD) / (0.3 - CLOSE_EYE_THRESHOLD))

            # ---------------- GAZE ESTIMATION ----------------
            l_cx = int(np.mean([face_landmarks.landmark[i].x for i in LEFT_IRIS]) * w)
            l_cy = int(np.mean([face_landmarks.landmark[i].y for i in LEFT_IRIS]) * h)
            r_cx = int(np.mean([face_landmarks.landmark[i].x for i in RIGHT_IRIS]) * w)
            r_cy = int(np.mean([face_landmarks.landmark[i].y for i in RIGHT_IRIS]) * h)

            eye_center_x = (l_cx + r_cx) / 2
            eye_center_y = (l_cy + r_cy) / 2
            nx, ny = int(face_landmarks.landmark[1].x * w), int(face_landmarks.landmark[1].y * h)

            horiz_norm = abs(eye_center_x - nx) / w
            vert_norm = abs(eye_center_y - ny) / h

            gaze_score = max(0.0, 1.0 - (horiz_norm * 5))
            head_pose_score = max(0.0, 1.0 - (vert_norm * 5))

            # ---------------- HEAD POSE (solvePnP) ----------------
            image_points = np.array([
                (face_landmarks.landmark[1].x * w, face_landmarks.landmark[1].y * h),     # Nose tip
                (face_landmarks.landmark[152].x * w, face_landmarks.landmark[152].y * h), # Chin
                (face_landmarks.landmark[33].x * w, face_landmarks.landmark[33].y * h),   # Left eye
                (face_landmarks.landmark[263].x * w, face_landmarks.landmark[263].y * h), # Right eye
                (face_landmarks.landmark[61].x * w, face_landmarks.landmark[61].y * h),   # Left mouth
                (face_landmarks.landmark[291].x * w, face_landmarks.landmark[291].y * h)  # Right mouth
            ], dtype=np.float64)

            focal_length = w
            center = (w/2, h/2)
            camera_matrix = np.array([
                [focal_length, 0, center[0]],
                [0, focal_length, center[1]],
                [0, 0, 1]
            ], dtype=np.float64)
            dist_coeffs = np.zeros((4, 1))

            try:
                _, rvec, tvec = cv2.solvePnP(model_points, image_points, camera_matrix, dist_coeffs)
                rmat, _ = cv2.Rodrigues(rvec)
                angles, _, _, _, _, _ = cv2.RQDecomp3x3(rmat)
                pitch, yaw, roll = [a * 180 for a in angles]  # in degrees

                # Penalize large deviations
                if abs(yaw) > 20 or abs(pitch) > 20:
                    head_pose_score *= 0.5
            except:
                pass

            # ---------------- ATTENTION SCORE ----------------
            attention_score = (0.4 * gaze_score + 0.3 * head_pose_score + 0.3 * eye_openness_score)

            # Apply smoothing
            att_history.append(attention_score)
            attention_score = sum(att_history) / len(att_history)

            # Micro-sleep detection
            if eyes_closed_frames > FPS * 2:
                attention_score = 0.0
                cv2.putText(frame, "ALERT: Drowsy!", (30, 120),
                            cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 3)

            cv2.putText(frame, f"Attention: {attention_score:.2f}", (30, 40),
                        cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 0), 2)

            # ---------------- DRAW BAR ----------------
            # Bar background (outline)
            cv2.rectangle(frame, (30, 150), (30 + BAR_MAX_WIDTH, 150 + BAR_HEIGHT), (100, 100, 100), 2)
            # Bar fill according to attention_score
            fill_width = int(BAR_MAX_WIDTH * max(0.0, min(1.0, attention_score)))
            cv2.rectangle(frame, (30, 150), (30 + fill_width, 150 + BAR_HEIGHT), (0, 255, 255), -1)
            cv2.putText(frame, "Attention Bar", (30, 145),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)

        else:
            cv2.putText(frame, "No face detected", (30, 40),
                        cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)

        cv2.imshow("Attention Score", frame)

        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

cap.release()
cv2.destroyAllWindows()
