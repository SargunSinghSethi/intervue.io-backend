const express = require("express")
const http = require("http")
const socketIo = require("socket.io")
const cors = require("cors")
require("dotenv").config()

const app = express()
const server = http.createServer(app)
const allowedOrigins = process.env.ALLOWED_ORIGINS.split(",");

const io = socketIo(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
  },
});

app.use(cors())
app.use(express.json())

// Store active sessions
let currentQuestion = null
const participants = new Map() // socketId -> {name, role}
const answers = new Map() // questionId -> Map(studentName -> answer)
let questionTimer = null
let timeLeft = 0
let questionNumber = 0
const questionHistory = new Map() // Store question numbers by question ID

// Socket connection handling
io.on("connection", (socket) => {
  console.log("User connected:", socket.id)

  // Teacher joins
  socket.on("teacherJoin", () => {
    participants.set(socket.id, { name: "Teacher", role: "teacher" })
    socket.join("teachers")

    // Send current participants to teacher
    const studentList = Array.from(participants.values())
      .filter((p) => p.role === "student")
      .map((p) => p.name)
    socket.emit("participantsUpdate", studentList)

    // Send question status
    socket.emit("questionStatus", { canAskNew: !currentQuestion || isQuestionComplete() })
  })

  // Student joins
  socket.on("studentJoin", (studentName) => {
    participants.set(socket.id, { name: studentName, role: "student" })
    socket.join("students")

    // Update all clients with new participant list
    const studentList = Array.from(participants.values())
      .filter((p) => p.role === "student")
      .map((p) => p.name)
    io.emit("participantsUpdate", studentList)

    // If there's a current question, send it to the new student
    if (currentQuestion) {
      socket.emit("questionStarted", currentQuestion)
      socket.emit("timeUpdate", timeLeft)
    }
  })

  // Teacher starts a question
  socket.on("startQuestion", (question) => {
    // Check if we can ask a new question
    if (currentQuestion && !isQuestionComplete()) {
      // Send error back to teacher
      socket.emit("questionError", {
        message:
          "Cannot ask a new question while the current question is still active. Please wait for all students to answer or for the timer to expire.",
      })
      return
    }

    // Increment question number
    questionNumber++

    // Store the question number for this question ID
    questionHistory.set(question.id, questionNumber)

    // Add question number to the question object
    currentQuestion = {
      ...question,
      questionNumber: questionNumber,
    }

    answers.set(question.id, new Map())
    timeLeft = question.timeLimit

    // Clear any existing timer
    if (questionTimer) {
      clearInterval(questionTimer)
    }

    // Start countdown timer
    questionTimer = setInterval(() => {
      timeLeft--
      io.emit("timeUpdate", timeLeft)

      if (timeLeft <= 0) {
        clearInterval(questionTimer)
        endQuestion()
      }
    }, 1000)

    // Send question to all students
    io.to("students").emit("questionStarted", currentQuestion)
    io.emit("timeUpdate", timeLeft)

    // Update teacher about question status
    io.to("teachers").emit("questionStatus", { canAskNew: false })
  })

  // Student submits answer
  socket.on("submitAnswer", (data) => {
    const { questionId, answer, studentName } = data

    if (currentQuestion && currentQuestion.id === questionId) {
      const questionAnswers = answers.get(questionId)
      if (questionAnswers && !questionAnswers.has(studentName)) {
        questionAnswers.set(studentName, answer)

        // Check if all students have answered
        const totalStudents = Array.from(participants.values()).filter((p) => p.role === "student").length

        if (questionAnswers.size >= totalStudents) {
          // All students answered, end question immediately
          if (questionTimer) {
            clearInterval(questionTimer)
          }
          endQuestion()
        }
      }
    }
  })

  // Chat message
  socket.on("chatMessage", (data) => {
    io.emit("chatMessage", data)
  })

  // Kick student
  socket.on("kickStudent", (studentName) => {
    // Find the student's socket
    for (const [socketId, participant] of participants.entries()) {
      if (participant.name === studentName && participant.role === "student") {
        // Remove from participants
        participants.delete(socketId)

        // Notify the student they've been kicked
        io.to(socketId).emit("studentKicked")

        // Update participant list for everyone
        const studentList = Array.from(participants.values())
          .filter((p) => p.role === "student")
          .map((p) => p.name)
        io.emit("participantsUpdate", studentList)

        // Disconnect the student
        const studentSocket = io.sockets.sockets.get(socketId)
        if (studentSocket) {
          studentSocket.disconnect()
        }
        break
      }
    }
  })

  // Handle disconnect
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id)
    participants.delete(socket.id)

    // Update participant list
    const studentList = Array.from(participants.values())
      .filter((p) => p.role === "student")
      .map((p) => p.name)
    io.emit("participantsUpdate", studentList)
  })
})

// Helper function to end current question
function endQuestion() {
  if (!currentQuestion) return

  const questionAnswers = answers.get(currentQuestion.id)
  if (!questionAnswers) return

  // Calculate results
  const results = calculateResults(currentQuestion.options, questionAnswers)

  // Add question number to results
  const resultsWithQuestionNumber = {
    results: results,
    questionNumber: currentQuestion.questionNumber,
    questionId: currentQuestion.id,
    questionText: currentQuestion.text,
  }

  // Send results to all clients
  io.emit("pollResults", resultsWithQuestionNumber)

  // Update teacher about question status
  io.to("teachers").emit("questionStatus", { canAskNew: true })

  // Clear current question
  currentQuestion = null
  timeLeft = 0
}

// Helper function to check if question is complete
function isQuestionComplete() {
  if (!currentQuestion) return true

  const questionAnswers = answers.get(currentQuestion.id)
  if (!questionAnswers) return false

  const totalStudents = Array.from(participants.values()).filter((p) => p.role === "student").length

  // Question is complete if all students answered OR time ran out
  return questionAnswers.size >= totalStudents || timeLeft <= 0
}

// Helper function to calculate poll results
function calculateResults(options, questionAnswers) {
  const answerCounts = new Map()

  // Initialize counts
  options.forEach((option) => {
    answerCounts.set(option, 0)
  })

  // Count answers
  for (const answer of questionAnswers.values()) {
    if (answerCounts.has(answer)) {
      answerCounts.set(answer, answerCounts.get(answer) + 1)
    }
  }

  // Calculate percentages
  const totalAnswers = questionAnswers.size
  const results = []

  for (const [option, count] of answerCounts.entries()) {
    const percentage = totalAnswers > 0 ? Math.round((count / totalAnswers) * 100) : 0
    results.push({
      option,
      count,
      percentage,
    })
  }

  return results
}

const PORT = process.env.PORT || 3001
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
